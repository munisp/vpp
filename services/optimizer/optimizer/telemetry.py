"""OpenTelemetry tracing + Prometheus metrics for the optimizer service.

Design contract (shared across services):
  * ``OTEL_SDK_DISABLED=true`` is the escape hatch — no SDK is initialised.
  * ``OTEL_EXPORTER_OTLP_ENDPOINT`` (gRPC) must be set to enable export; when
    unset the service logs ``telemetry disabled: <reason>`` loudly and runs
    fine without tracing. Collector unavailability must never crash the
    service: the OTLP gRPC exporter connects lazily and the batch processor
    swallows export errors.
  * ``OTEL_SERVICE_NAME`` / ``OTEL_SERVICE_VERSION`` / ``OTEL_ENVIRONMENT`` /
    ``OTEL_TENANT_ID`` populate the resource (``tenant.id`` default ``default``).
  * ``/health`` exposes ``telemetry: {enabled, reason?}`` via :func:`status`.

Metrics are served by prometheus-client at ``GET /metrics`` on the main port
(8000), matching the scrape pattern used for the Fluvio consumers.
"""

from __future__ import annotations

import logging
import os
import time
from contextlib import contextmanager
from typing import Any, Iterator

from prometheus_client import Counter, Histogram

logger = logging.getLogger(__name__)

_SERVICE_NAME = "optimizer"

# ---------------------------------------------------------------------------
# Prometheus metrics (always on; independent of the OTel SDK state).
# ---------------------------------------------------------------------------

HTTP_REQUESTS = Counter(
    "optimizer_http_requests_total",
    "HTTP requests handled by the optimizer",
    ["method", "endpoint", "status"],
)

SOLVE_DURATION = Histogram(
    "optimizer_solve_duration_seconds",
    "Wall-clock duration of optimizer solve operations",
    ["operation", "solver", "status"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0),
)

# ---------------------------------------------------------------------------
# OTel tracing initialisation.
# ---------------------------------------------------------------------------

_state: dict[str, Any] = {"enabled": False, "reason": "telemetry not initialised"}


def status() -> dict[str, Any]:
    """Telemetry status surfaced in /health."""
    return dict(_state)


def _set_disabled(reason: str) -> None:
    _state["enabled"] = False
    _state["reason"] = reason
    logger.warning("telemetry disabled: %s", reason)


def init_telemetry() -> dict[str, Any]:
    """Initialise the OTel tracer provider.

    Call before the FastAPI app is created. Safe in any environment: honours
    ``OTEL_SDK_DISABLED`` and a missing endpoint, and converts any
    initialisation failure into "disabled with a reason" rather than an
    exception.
    """
    if os.environ.get("OTEL_SDK_DISABLED", "").strip().lower() in {"1", "true", "yes", "on"}:
        _set_disabled("OTEL_SDK_DISABLED is set")
        return status()

    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip()
    if not endpoint:
        _set_disabled("OTEL_EXPORTER_OTLP_ENDPOINT is not set")
        return status()

    try:
        from opentelemetry import metrics as otel_metrics
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import (
            OTLPMetricExporter,
        )
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        # Stable HTTP semantic conventions: with "http" opt-in the FastAPI/ASGI
        # instrumentor emits http.server.request.duration (seconds), which the
        # collector's Prometheus exporter serves as
        # http_server_request_duration_seconds_* (INFRA dashboard contract).
        os.environ.setdefault("OTEL_SEMCONV_STABILITY_OPT_IN", "http")

        resource = Resource.create(
            {
                "service.name": os.environ.get("OTEL_SERVICE_NAME", _SERVICE_NAME),
                "service.version": os.environ.get("OTEL_SERVICE_VERSION", "unknown"),
                "deployment.environment": os.environ.get("OTEL_ENVIRONMENT", "development"),
                "tenant.id": os.environ.get("OTEL_TENANT_ID", "default"),
            }
        )
        provider = TracerProvider(resource=resource)
        # Lazy gRPC channel: an absent collector yields dropped batches, never
        # a crash, and export errors are logged by the SDK, not raised.
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
        trace.set_tracer_provider(provider)

        # Metrics pipeline over the same OTLP gRPC endpoint: carries the
        # instrumentor's HTTP server metrics (and any future custom meters)
        # to the collector. Export failures are logged, never raised.
        meter_provider = MeterProvider(
            resource=resource,
            metric_readers=[
                PeriodicExportingMetricReader(OTLPMetricExporter(endpoint=endpoint))
            ],
        )
        otel_metrics.set_meter_provider(meter_provider)

        _state["enabled"] = True
        _state.pop("reason", None)
        logger.info(
            "telemetry enabled: exporting OTLP gRPC traces to %s (service=%s)",
            endpoint,
            resource.attributes.get("service.name"),
        )
    except Exception as exc:  # never let telemetry break the service
        _set_disabled(f"initialisation failed: {exc}")
    return status()


def instrument_app(app: Any) -> None:
    """Attach FastAPI auto-instrumentation (no-op when telemetry is disabled).

    The instrumentor extracts W3C tracecontext (traceparent/tracestate) from
    incoming request headers automatically, so a trace started by the
    TypeScript caller continues here.
    """
    if not _state["enabled"]:
        return
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        try:
            FastAPIInstrumentor.instrument_app(app)
        except RuntimeError as exc:
            # Starlette refuses new middleware once the stack is built (e.g. a
            # TestClient already served a request). Drop the cached stack so
            # it is lazily rebuilt including the OTel middleware, then retry.
            if "middleware" in str(exc).lower() and getattr(app, "middleware_stack", None) is not None:
                app.middleware_stack = None
                FastAPIInstrumentor.instrument_app(app)
            else:
                raise
    except Exception as exc:  # never let telemetry break the service
        logger.warning("FastAPI instrumentation skipped: %s", exc)


def get_tracer(name: str = _SERVICE_NAME):
    from opentelemetry import trace

    return trace.get_tracer(name)


# ---------------------------------------------------------------------------
# Solver span helper.
# ---------------------------------------------------------------------------


@contextmanager
def solve_span(operation: str) -> Iterator[dict[str, Any]]:
    """Wrap one solver operation in a ``pulp.solve`` child span.

    Yields a mutable attribute bag; endpoint handlers drop result fields in
    (``solver``, ``variables``, ``constraints``, ``status``, ``objective``)
    and they become span attributes. Also records the solve-duration
    Prometheus histogram. With telemetry disabled this is a no-op span.
    """
    attributes: dict[str, Any] = {}
    start = time.perf_counter()
    if not _state["enabled"]:
        try:
            yield attributes
        finally:
            _record_solve_metric(operation, attributes, time.perf_counter() - start)
        return

    tracer = get_tracer()
    with tracer.start_as_current_span(
        "pulp.solve",
        attributes={"optimizer.operation": operation},
    ) as span:
        try:
            yield attributes
        finally:
            for key, value in attributes.items():
                if value is None:
                    continue
                if isinstance(value, (bool, int, float, str)):
                    span.set_attribute(f"optimizer.{key}", value)
            span.set_attribute("optimizer.operation", operation)
            _record_solve_metric(operation, attributes, time.perf_counter() - start)


def _record_solve_metric(operation: str, attributes: dict[str, Any], seconds: float) -> None:
    SOLVE_DURATION.labels(
        operation=operation,
        solver=str(attributes.get("solver") or "unknown"),
        status=str(attributes.get("status") or "unknown"),
    ).observe(seconds)


def result_attributes(result: Any) -> dict[str, Any]:
    """Pull standard span attributes out of a solver response object.

    Works across Dispatch/Stochastic/MPC/Coordination responses (status,
    solver, diagnostics) and degrades to whatever is present (design study).
    """
    attributes: dict[str, Any] = {}
    status = getattr(result, "status", None)
    if status is not None:
        attributes["status"] = getattr(status, "value", status)
    solver = getattr(result, "solver", None)
    if solver:
        attributes["solver"] = solver
    diagnostics = getattr(result, "diagnostics", None) or {}
    if isinstance(diagnostics, dict):
        if "variables" in diagnostics:
            attributes["variables"] = diagnostics["variables"]
        if "constraints" in diagnostics:
            attributes["constraints"] = diagnostics["constraints"]
    totals = getattr(result, "totals", None)
    objective = getattr(totals, "objective_value_cents", None) if totals is not None else None
    if objective is None:
        objective = diagnostics.get("objective_value_cents") if isinstance(diagnostics, dict) else None
    if objective is not None:
        attributes["objective"] = objective
    return attributes
