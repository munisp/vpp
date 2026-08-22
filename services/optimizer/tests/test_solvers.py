"""Solver discovery: an absent solver is an error, never a heuristic fallback."""

from __future__ import annotations

import pytest

from optimizer import solvers
from optimizer.solvers import SolverUnavailable, available_solvers, resolve_solver_name


def test_a_real_solver_is_discovered():
    assert available_solvers()
    assert resolve_solver_name() in available_solvers()


def test_unknown_requested_solver_is_refused():
    with pytest.raises(SolverUnavailable, match="not available"):
        resolve_solver_name("NO_SUCH_SOLVER")


def test_environment_override_is_honoured(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OPTIMIZER_SOLVER", "NO_SUCH_SOLVER")
    with pytest.raises(SolverUnavailable):
        resolve_solver_name()


def test_no_solver_installed_raises_instead_of_degrading(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(solvers, "available_solvers", lambda: [])
    with pytest.raises(SolverUnavailable, match="no MILP solver"):
        resolve_solver_name()
