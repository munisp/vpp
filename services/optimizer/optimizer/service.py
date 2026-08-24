"""HTTP surface for the dispatch optimizer.

Status handling is deliberate: a solve that did not reach optimality returns
4xx/5xx, never a 200 with an empty-but-plausible schedule. Callers therefore
cannot mistake "no solution" for "do nothing".
"""

from __future__ import annotations

import logging
import os

from typing import Annotated

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

from .design import run_design_study
from .design_schemas import DesignRequest, DesignResponse
from .distributed import coordinate
from .dispatch import solve_dispatch
from .mpc import run_mpc
from .schemas import (
    CoordinationRequest,
    CoordinationResponse,
    DispatchRequest,
    DispatchResponse,
    MPCRequest,
    MPCResponse,
    SolveStatus,
    StochasticRequest,
    StochasticResponse,
)
from .solvers import SolverUnavailable, available_solvers, resolve_solver_name
from .stochastic import solve_stochastic

logging.basicConfig(
    level=os.environ.get("OPTIMIZER_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="VPP dispatch optimizer",
    version="1.0.0",
    description=(
        "Mixed-integer linear dispatch optimisation: deterministic, two-stage "
        "stochastic with CVaR, rolling-horizon MPC, and multi-site coordination."
    ),
)

# Shared secret between the Node server and this service. Enforced whenever set;
# in production the caller is expected to set it.
_TOKEN_ENV = "OPTIMIZER_AUTH_TOKEN"


def _authorise(token: str | None) -> None:
    expected = os.environ.get(_TOKEN_ENV)
    if not expected:
        if os.environ.get("NODE_ENV") == "production" or os.environ.get("OPTIMIZER_ENV") == "production":
            raise HTTPException(
                status_code=500,
                detail=f"{_TOKEN_ENV} must be set when running in production",
            )
        return
    if token != expected:
        raise HTTPException(status_code=401, detail="invalid optimizer token")


def _status_to_http(status: SolveStatus) -> int:
    if status is SolveStatus.INFEASIBLE:
        return 422
    if status is SolveStatus.UNBOUNDED:
        return 422
    if status is SolveStatus.NOT_CONVERGED:
        return 409
    return 503


@app.exception_handler(SolverUnavailable)
async def _solver_unavailable(_request, exc: SolverUnavailable) -> JSONResponse:
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.exception_handler(ValueError)
async def _value_error(_request, exc: ValueError) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.get("/health")
def health() -> dict[str, object]:
    """Report solver availability. Unhealthy when no MILP solver is installed."""
    try:
        solver = resolve_solver_name()
    except SolverUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {
        "status": "ok",
        "solver": solver,
        "available_solvers": available_solvers(),
    }


def _check(result, status: SolveStatus) -> None:
    if status is not SolveStatus.OPTIMAL:
        raise HTTPException(
            status_code=_status_to_http(status),
            detail={
                "status": status.value,
                "diagnostics": result.diagnostics,
                "message": (
                    "the optimisation did not reach a proven-optimal solution; "
                    "no dispatch schedule is returned"
                ),
            },
        )


@app.post("/optimize/dispatch", response_model=DispatchResponse)
def optimize_dispatch(
    request: DispatchRequest,
    x_optimizer_token: Annotated[str | None, Header()] = None,
) -> DispatchResponse:
    _authorise(x_optimizer_token)
    result = solve_dispatch(request)
    _check(result, result.status)
    return result


@app.post("/optimize/stochastic", response_model=StochasticResponse)
def optimize_stochastic(
    request: StochasticRequest,
    x_optimizer_token: Annotated[str | None, Header()] = None,
) -> StochasticResponse:
    _authorise(x_optimizer_token)
    result = solve_stochastic(request)
    _check(result, result.status)
    return result


@app.post("/optimize/mpc", response_model=MPCResponse)
def optimize_mpc(
    request: MPCRequest,
    x_optimizer_token: Annotated[str | None, Header()] = None,
) -> MPCResponse:
    _authorise(x_optimizer_token)
    result = run_mpc(request)
    _check(result, result.status)
    return result


@app.post("/design/study", response_model=DesignResponse)
def design_study(
    request: DesignRequest,
    x_optimizer_token: Annotated[str | None, Header()] = None,
) -> DesignResponse:
    """Size a site that does not exist yet.

    Unlike the dispatch endpoints this answers 200 when no candidate sizing
    meets the study's unserved-energy limit: `status` is
    `no_feasible_candidate`, `recommended` is null, and every candidate's
    numbers are returned so the caller can see how far off they were. A
    missing load profile, resource series or cost assumption is a 400 from
    schema validation, not a study with an assumption substituted in.
    """

    _authorise(x_optimizer_token)
    return run_design_study(request)


@app.post("/optimize/coordinate", response_model=CoordinationResponse)
def optimize_coordinate(
    request: CoordinationRequest,
    x_optimizer_token: Annotated[str | None, Header()] = None,
) -> CoordinationResponse:
    _authorise(x_optimizer_token)
    result = coordinate(request)
    _check(result, result.status)
    return result
