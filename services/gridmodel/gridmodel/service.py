"""HTTP surface for the network feasibility service.

`POST /feasibility` always answers 200 with a status, because every outcome here
is information the caller must act on differently: `feasible` binds a dispatch or
an award, `violations` refuses it and names the element, `model_unavailable`
labels the decision network-unchecked, and `not_converged` is neither. Collapsing
those into 4xx/5xx would let a caller read "not feasible" as "no model", which is
the one confusion that leads to paying for relief the network cannot carry.
"""

from __future__ import annotations

import logging
import os

from typing import Annotated

import pandapower as pp

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

from .powerflow import evaluate
from .schemas import FeasibilityRequest, FeasibilityResponse

logging.basicConfig(
    level=os.environ.get("GRIDMODEL_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="VPP network feasibility",
    version="1.0.0",
    description=(
        "Power flow, limit checking and hosting capacity over a site network "
        "model, on the open source pandapower engine."
    ),
)

_TOKEN_ENV = "GRIDMODEL_AUTH_TOKEN"


def _authorise(token: str | None) -> None:
    expected = os.environ.get(_TOKEN_ENV)
    if not expected:
        if (
            os.environ.get("NODE_ENV") == "production"
            or os.environ.get("GRIDMODEL_ENV") == "production"
        ):
            raise HTTPException(
                status_code=500,
                detail=f"{_TOKEN_ENV} must be set when running in production",
            )
        return
    if token != expected:
        raise HTTPException(status_code=401, detail="invalid gridmodel token")


@app.exception_handler(ValueError)
async def _value_error(_request, exc: ValueError) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.get("/health")
def health() -> dict[str, object]:
    return {"status": "ok", "engine": "pandapower", "engine_version": pp.__version__}


@app.post("/feasibility", response_model=FeasibilityResponse)
def feasibility(
    request: FeasibilityRequest,
    x_gridmodel_token: Annotated[str | None, Header()] = None,
) -> FeasibilityResponse:
    _authorise(x_gridmodel_token)
    response = evaluate(request)
    logger.info(
        "feasibility study=%s status=%s violations=%d",
        request.study_reference,
        response.status.value,
        len(response.violations),
    )
    return response
