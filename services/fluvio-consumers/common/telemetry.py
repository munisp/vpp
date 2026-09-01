"""OpenTelemetry tracing for the Fluvio consumers.

Shared env contract (same as the HTTP services):
  * ``OTEL_SDK_DISABLED=true`` is the escape hatch — no SDK is initialised.
  * ``OTEL_EXPORTER_OTLP_ENDPOINT`` (gRPC) must be set to enable export; when
    unset the consumer logs ``telemetry disabled: <reason>`` loudly and runs
    fine without tracing. Collector unavailability must never crash the
    consumer: the OTLP gRPC exporter connects lazily and the batch processor
    swallows export errors.
  * ``OTEL_SERVICE_NAME`` / ``OTEL_SERVICE_VERSION`` / ``OTEL_ENVIRONMENT`` /
    ``OTEL_TENANT_ID`` populate the resource (``tenant.id`` default ``default``).

Propagation: the mqtt-fluvio-bridge stamps W3C ``traceparent`` (and optional
``tracestate``) into the record payload envelope, and the SmartModules
preserve it. :func:`extract_record_context` pulls it back out and
:func:`consume_span` continues that trace for each consumed record.

There is no HTTP framework here, so no ``/health`` route; the telemetry
status is logged loudly at startup and exposed via :func:`status`.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Any, Iterator, Optional

from loguru import logger

_state: dict[str, Any] = {"enabled": False, "reason": "telemetry not initialised"}


def status() -> dict[str, Any]:
    """Current telemetry status (also logged at startup)."""
    return dict(_state)


def _set_disabled(reason: str) -> None:
    _state["enabled"] = False
    _state["reason"] = reason
    logger.warning(f"telemetry disabled: {reason}")


def init_telemetry(default_service_name: str) -> dict[str, Any]:
    """Initialise the OTel tracer provider for a consumer process.

    Safe in any environment: honours ``OTEL_SDK_DISABLED`` and a missing
    endpoint, and converts any initialisation failure into "disabled with a
    reason" rather than an exception.
    """
    if os.environ.get("OTEL_SDK_DISABLED", "").strip().lower() in {"1", "true", "yes", "on"}:
        _set_disabled("OTEL_SDK_DISABLED is set")
        return status()

    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip()
    if not endpoint:
        _set_disabled("OTEL_EXPORTER_OTLP_ENDPOINT is not set")
        return status()

    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        resource = Resource.create(
            {
                "service.name": os.environ.get("OTEL_SERVICE_NAME", default_service_name),
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

        _state["enabled"] = True
        _state.pop("reason", None)
        logger.info(
            "telemetry enabled: exporting OTLP gRPC traces to {} (service={})",
            endpoint,
            resource.attributes.get("service.name"),
        )
    except Exception as exc:  # never let telemetry break the consumer
        _set_disabled(f"initialisation failed: {exc}")
    return status()


def _get_tracer():
    from opentelemetry import trace

    return trace.get_tracer("fluvio-consumers")


def extract_record_context(payload: Any) -> Optional[Any]:
    """Extract a W3C trace context from a record payload envelope.

    The mqtt-fluvio-bridge stamps ``traceparent``/``tracestate`` into the JSON
    payload; returns an OTel Context with the remote span context, or None
    when the payload carries no usable context.
    """
    if not isinstance(payload, dict):
        return None
    carrier: dict[str, str] = {}
    traceparent = payload.get("traceparent")
    if isinstance(traceparent, str) and traceparent:
        carrier["traceparent"] = traceparent
    tracestate = payload.get("tracestate")
    if isinstance(tracestate, str) and tracestate:
        carrier["tracestate"] = tracestate
    if not carrier:
        return None

    from opentelemetry import propagate

    context = propagate.extract(carrier)
    # A malformed traceparent yields an invalid span context; treat as absent.
    from opentelemetry import trace

    span_context = trace.get_current_span(context).get_span_context()
    if span_context is None or not span_context.is_valid:
        return None
    return context


def _record_offset(record: Any) -> Optional[int]:
    offset = getattr(record, "offset", None)
    if callable(offset):
        try:
            return offset()
        except Exception:
            return None
    return offset if isinstance(offset, int) else None


@contextmanager
def consume_span(
    record: Any,
    *,
    topic: str,
    partition: int,
    payload: Any = None,
) -> Iterator[None]:
    """Wrap processing of one Fluvio record in a consumer span.

    Continues the trace stamped into the payload envelope by the bridge (via
    manual context attach) when present; otherwise starts a fresh trace. Span
    name ``messaging.fluvio.consume`` with partition/offset attributes.
    No-op span when telemetry is disabled.
    """
    if not _state["enabled"]:
        yield
        return

    from opentelemetry import context as otel_context
    from opentelemetry.trace import SpanKind

    parent = extract_record_context(payload)
    token = otel_context.attach(parent) if parent is not None else None
    attributes: dict[str, Any] = {
        "messaging.system": "fluvio",
        "messaging.destination.name": topic,
        "messaging.operation": "consume",
        "messaging.fluvio.partition": partition,
    }
    offset = _record_offset(record)
    if offset is not None:
        attributes["messaging.fluvio.offset"] = offset

    try:
        with _get_tracer().start_as_current_span(
            "messaging.fluvio.consume",
            kind=SpanKind.CONSUMER,
            attributes=attributes,
        ):
            yield
    finally:
        if token is not None:
            otel_context.detach(token)


@contextmanager
def db_write_span(table: str, *, records: int = 1) -> Iterator[None]:
    """Wrap a database write batch in a child span (database-consumer)."""
    if not _state["enabled"]:
        yield
        return

    from opentelemetry.trace import SpanKind

    with _get_tracer().start_as_current_span(
        "db.telemetry.insert",
        kind=SpanKind.CLIENT,
        attributes={
            "db.system": "postgresql",
            "db.sql.table": table,
            "db.operation": "insert",
            "db.batch.records": records,
        },
    ):
        yield
