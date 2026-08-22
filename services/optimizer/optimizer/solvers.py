"""Solver discovery.

The service refuses to run without a real MILP solver. There is deliberately no
"approximate" or heuristic fallback here: a dispatch schedule that was never
optimised must not be returned as if it had been.
"""

from __future__ import annotations

import logging
import os

import pulp

logger = logging.getLogger(__name__)

# Preference order: HiGHS is faster and better licensed than bundled CBC, but
# CBC ships with PuLP so it is the guaranteed-available fallback.
_PREFERRED = ("HiGHS_CMD", "HiGHS", "PULP_CBC_CMD", "COIN_CMD", "GUROBI_CMD", "CPLEX_CMD")


class SolverUnavailable(RuntimeError):
    """Raised when no MILP solver is installed."""


def available_solvers() -> list[str]:
    return pulp.listSolvers(onlyAvailable=True)


def resolve_solver_name(requested: str | None = None) -> str:
    """Pick a solver name, honouring OPTIMIZER_SOLVER then the preference order."""
    available = available_solvers()
    if not available:
        raise SolverUnavailable(
            "no MILP solver is available to PuLP; install HiGHS "
            "(pip install highspy) or CBC (pip install pulp[cbc])"
        )

    candidate = requested or os.environ.get("OPTIMIZER_SOLVER") or ""
    if candidate:
        if candidate not in available:
            raise SolverUnavailable(
                f"requested solver {candidate!r} is not available; "
                f"available solvers: {', '.join(available)}"
            )
        return candidate

    for name in _PREFERRED:
        if name in available:
            return name
    return available[0]


def build_solver(
    *,
    time_limit_seconds: float,
    relative_gap: float = 0.0,
    requested: str | None = None,
) -> pulp.LpSolver:
    """Instantiate a configured solver, or raise SolverUnavailable."""
    name = resolve_solver_name(requested)
    cls = pulp.getSolver
    kwargs: dict[str, object] = {"msg": False, "timeLimit": max(1, int(time_limit_seconds))}
    if relative_gap > 0:
        # PuLP normalises this across CBC/HiGHS/Gurobi.
        kwargs["gapRel"] = relative_gap
    try:
        return cls(name, **kwargs)
    except Exception as exc:  # pragma: no cover - depends on local solver build
        raise SolverUnavailable(f"failed to initialise solver {name}: {exc}") from exc
