"""Multi-site coordination under a shared grid constraint.

Each site keeps its own MILP — sites do not share load, price or asset data —
and the shared connection limit is enforced by pricing it. The coordinator
raises the price of aggregate import in intervals where the limit is exceeded
and lowers it where there is headroom, i.e. projected subgradient ascent on the
Lagrangian dual:

    lambda_t <- max(0, lambda_t + step * (aggregate_t - limit_t))

This is dual decomposition, not quadratic-penalty ADMM. The subproblems are
mixed-integer, so the dual has a duality gap and the iteration can stall short
of a feasible allocation; when that happens the response says so
(`converged: false` with the residual violation) instead of returning an
allocation that silently breaches the transformer rating.
"""

from __future__ import annotations

import logging

from .dispatch import solve_dispatch
from .schemas import (
    W_PER_KW,
    CoordinationRequest,
    CoordinationResponse,
    DispatchRequest,
    DispatchResponse,
    Prices,
    SolveStatus,
)
from .solvers import resolve_solver_name

logger = logging.getLogger(__name__)


def _priced_request(
    base: DispatchRequest,
    import_multiplier: list[float],
    export_multiplier: list[float],
) -> DispatchRequest:
    """Add the coordination shadow prices to a site's own tariff."""
    request = base.model_copy(deep=True)
    request.prices = Prices(
        import_cents_per_kwh=[
            base.prices.import_cents_per_kwh[t] + import_multiplier[t]
            for t in range(base.horizon)
        ],
        # A binding export limit reduces the value of exporting.
        export_cents_per_kwh=[
            base.prices.export_cents_per_kwh[t] - export_multiplier[t]
            for t in range(base.horizon)
        ],
        grid_emissions_g_per_kwh=base.prices.grid_emissions_g_per_kwh,
    )
    return request


def _aggregate(results: list[DispatchResponse], horizon: int) -> tuple[list[float], list[float]]:
    imports = [0.0] * horizon
    exports = [0.0] * horizon
    for result in results:
        for interval in result.intervals:
            imports[interval.index] += interval.grid_import_w
            exports[interval.index] += interval.grid_export_w
    return imports, exports


def coordinate(
    request: CoordinationRequest, *, solver_name: str | None = None
) -> CoordinationResponse:
    horizon = request.sites[0].request.horizon
    interval_hours = request.sites[0].request.interval_hours
    import_multiplier = [0.0] * horizon
    export_multiplier = [0.0] * horizon

    best_results: list[DispatchResponse] | None = None
    best_violation = float("inf")
    iterations = 0
    step = request.step_size_cents_per_kwh

    for iteration in range(request.max_iterations):
        iterations = iteration + 1
        results: list[DispatchResponse] = []
        for site in request.sites:
            priced = _priced_request(site.request, import_multiplier, export_multiplier)
            result = solve_dispatch(priced, solver_name=solver_name)
            if result.status is not SolveStatus.OPTIMAL:
                logger.warning(
                    "coordination aborted: site %s returned %s",
                    site.request.site.site_id,
                    result.status.value,
                )
                return CoordinationResponse(
                    status=result.status,
                    solver=resolve_solver_name(solver_name),
                    iterations=iterations,
                    max_violation_w=0.0,
                    converged=False,
                    shadow_prices_cents_per_kwh=import_multiplier,
                    sites=results + [result],
                    diagnostics={
                        "failed_site": site.request.site.site_id,
                        "reason": "subproblem did not solve to optimality",
                    },
                )
            results.append(result)

        imports, exports = _aggregate(results, horizon)
        import_violation = [imports[t] - request.shared_import_limit_w[t] for t in range(horizon)]
        export_violation = (
            [exports[t] - request.shared_export_limit_w[t] for t in range(horizon)]
            if request.shared_export_limit_w is not None
            else [0.0] * horizon
        )
        max_violation = max(
            [0.0] + [v for v in import_violation] + [v for v in export_violation]
        )

        if max_violation < best_violation:
            best_violation = max_violation
            best_results = results

        if max_violation <= request.tolerance_w:
            return CoordinationResponse(
                status=SolveStatus.OPTIMAL,
                solver=resolve_solver_name(solver_name),
                iterations=iterations,
                max_violation_w=max(0.0, max_violation),
                converged=True,
                shadow_prices_cents_per_kwh=import_multiplier,
                sites=results,
                diagnostics={
                    "aggregate_peak_import_w": max(imports),
                    "aggregate_peak_export_w": max(exports),
                    "step_size_cents_per_kwh": step,
                },
            )

        # Subgradient step, scaled to kWh so the multiplier stays in the same
        # units as the tariff it is added to.
        for t in range(horizon):
            delta_kwh = import_violation[t] / W_PER_KW * interval_hours
            import_multiplier[t] = max(0.0, import_multiplier[t] + step * delta_kwh)
            if request.shared_export_limit_w is not None:
                delta_export_kwh = export_violation[t] / W_PER_KW * interval_hours
                export_multiplier[t] = max(
                    0.0, export_multiplier[t] + step * delta_export_kwh
                )
        # Diminishing step size keeps the subgradient iteration from oscillating.
        step = request.step_size_cents_per_kwh / (1.0 + iteration)

    logger.warning(
        "coordination did not converge after %s iterations; residual violation %.1f W",
        iterations,
        best_violation,
    )
    return CoordinationResponse(
        status=SolveStatus.NOT_CONVERGED,
        solver=resolve_solver_name(solver_name),
        iterations=iterations,
        max_violation_w=best_violation,
        converged=False,
        shadow_prices_cents_per_kwh=import_multiplier,
        sites=best_results or [],
        diagnostics={
            "reason": (
                "dual decomposition did not reach a feasible allocation within "
                "max_iterations; the returned plan still breaches the shared limit"
            ),
            "tolerance_w": request.tolerance_w,
        },
    )
