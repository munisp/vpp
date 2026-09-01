"""Telemetry tests for the Fluvio consumers.

Covers the init matrix (disabled / no-endpoint / enabled), the traceparent
extraction helper round-trip, per-record consumer spans continuing the trace
stamped into the payload envelope, and the database write span.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common import telemetry  # noqa: E402

_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
_SPAN_ID = "00f067aa0ba902b7"

_PAYLOAD = {
    "device_id": "dev-1",
    "asset_id": 7,
    "timestamp": "2025-01-01T00:00:00Z",
    "power": 1200.0,
    "energy": 20.0,
    "voltage": 230.0,
    "current": 5.2,
    "frequency": 50.0,
    "power_factor": 0.95,
    "battery_level": 80.0,
}


class FakeRecord:
    def __init__(self, payload: dict, offset: int = 42):
        self._payload = payload
        self._offset = offset

    def value(self) -> bytes:
        return json.dumps(self._payload).encode()

    def offset(self) -> int:
        return self._offset


# ---------------------------------------------------------------------------
# Init matrix
# ---------------------------------------------------------------------------


def test_disabled_via_escape_hatch(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OTEL_SDK_DISABLED", "true")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
    state = telemetry.init_telemetry("fluvio-database-consumer")
    assert state["enabled"] is False
    assert "OTEL_SDK_DISABLED" in state["reason"]


def test_disabled_when_endpoint_unset(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("OTEL_SDK_DISABLED", raising=False)
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    state = telemetry.init_telemetry("fluvio-database-consumer")
    assert state["enabled"] is False
    assert "OTEL_EXPORTER_OTLP_ENDPOINT" in state["reason"]


@pytest.fixture(scope="module")
def exporter():
    """Enable telemetry once for the process with an in-memory exporter."""
    os.environ.pop("OTEL_SDK_DISABLED", None)
    os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://localhost:4317"
    os.environ["OTEL_SERVICE_NAME"] = "fluvio-database-consumer"
    os.environ["OTEL_TENANT_ID"] = "tenant-test"

    state = telemetry.init_telemetry("fluvio-database-consumer")
    assert state == {"enabled": True}

    from opentelemetry import trace
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
        InMemorySpanExporter,
    )

    memory = InMemorySpanExporter()
    provider = trace.get_tracer_provider()
    provider.add_span_processor(SimpleSpanProcessor(memory))

    yield memory

    os.environ.pop("OTEL_EXPORTER_OTLP_ENDPOINT", None)
    os.environ.pop("OTEL_SERVICE_NAME", None)
    os.environ.pop("OTEL_TENANT_ID", None)


def test_enabled_init_resource(exporter):
    from opentelemetry import trace

    resource = trace.get_tracer_provider().resource
    assert resource.attributes["service.name"] == "fluvio-database-consumer"
    assert resource.attributes["tenant.id"] == "tenant-test"


# ---------------------------------------------------------------------------
# traceparent extraction helper
# ---------------------------------------------------------------------------


def test_extract_record_context_round_trip(exporter):
    """inject() into a carrier -> payload envelope -> extract() must give back
    the same trace, which is exactly what the bridge stamping + consumer
    extraction do over a Fluvio record."""
    from opentelemetry import propagate, trace

    tracer = trace.get_tracer("test")
    carrier: dict[str, str] = {}
    with tracer.start_as_current_span("bridge-produce") as span:
        propagate.inject(carrier)
        expected_trace_id = span.get_span_context().trace_id

    payload = dict(_PAYLOAD)
    payload.update(carrier)  # what the mqtt-fluvio-bridge stamps

    context = telemetry.extract_record_context(payload)
    assert context is not None
    extracted = trace.get_current_span(context).get_span_context()
    assert extracted.is_valid
    assert extracted.trace_id == expected_trace_id
    assert extracted.is_remote


def test_extract_record_context_missing_or_malformed(exporter):
    assert telemetry.extract_record_context(dict(_PAYLOAD)) is None
    assert telemetry.extract_record_context({"traceparent": "not-a-traceparent"}) is None
    assert telemetry.extract_record_context("not a dict") is None


# ---------------------------------------------------------------------------
# Consumer + DB write spans
# ---------------------------------------------------------------------------


def test_consume_span_continues_payload_trace(exporter):
    exporter.clear()
    payload = dict(_PAYLOAD)
    payload["traceparent"] = _TRACEPARENT
    record = FakeRecord(payload, offset=42)

    with telemetry.consume_span(record, topic="telemetry", partition=0, payload=payload):
        pass

    spans = exporter.get_finished_spans()
    assert len(spans) == 1
    span = spans[0]
    assert span.name == "messaging.fluvio.consume"
    assert format(span.context.trace_id, "032x") == _TRACE_ID
    assert span.parent is not None
    assert format(span.parent.span_id, "016x") == _SPAN_ID
    assert span.attributes["messaging.system"] == "fluvio"
    assert span.attributes["messaging.destination.name"] == "telemetry"
    assert span.attributes["messaging.fluvio.partition"] == 0
    assert span.attributes["messaging.fluvio.offset"] == 42


def test_consume_span_without_traceparent_starts_new_trace(exporter):
    exporter.clear()
    with telemetry.consume_span(
        FakeRecord(dict(_PAYLOAD)), topic="telemetry", partition=0, payload=dict(_PAYLOAD)
    ):
        pass
    spans = exporter.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].parent is None


def test_db_write_span(exporter):
    exporter.clear()
    with telemetry.db_write_span("telemetry", records=1):
        pass
    spans = exporter.get_finished_spans()
    assert len(spans) == 1
    span = spans[0]
    assert span.name == "db.telemetry.insert"
    assert span.attributes["db.system"] == "postgresql"
    assert span.attributes["db.sql.table"] == "telemetry"


# ---------------------------------------------------------------------------
# Consumer wiring (logic identical; spans + metrics additive)
# ---------------------------------------------------------------------------


def test_database_consumer_process_message(exporter, monkeypatch: pytest.MonkeyPatch):
    pytest.importorskip("fluvio")
    pytest.importorskip("psycopg2")
    from database.consumer import DatabaseConsumer

    exporter.clear()
    consumer = DatabaseConsumer.__new__(DatabaseConsumer)
    consumer.fluvio_topic = "telemetry"
    consumer.fluvio_partition = 0

    stored = []
    monkeypatch.setattr(consumer, "store_telemetry", lambda t: stored.append(t) or True)

    payload = dict(_PAYLOAD)
    payload["traceparent"] = _TRACEPARENT
    consumer.process_message(FakeRecord(payload))

    assert len(stored) == 1
    assert stored[0].device_id == "dev-1"
    spans = exporter.get_finished_spans()
    consume = [s for s in spans if s.name == "messaging.fluvio.consume"]
    assert consume and format(consume[0].context.trace_id, "032x") == _TRACE_ID


def test_analytics_consumer_process_message(exporter):
    pytest.importorskip("fluvio")
    from analytics.consumer import AnalyticsConsumer

    exporter.clear()
    consumer = AnalyticsConsumer.__new__(AnalyticsConsumer)
    consumer.fluvio_topic = "telemetry"
    consumer.fluvio_partition = 0
    consumer.window_size = 60
    from collections import defaultdict
    from datetime import datetime

    consumer.windows = defaultdict(list)
    consumer.last_flush = datetime.now()

    payload = dict(_PAYLOAD)
    payload["traceparent"] = _TRACEPARENT
    consumer.process_message(FakeRecord(payload))

    assert sum(len(v) for v in consumer.windows.values()) == 1
    spans = exporter.get_finished_spans()
    consume = [s for s in spans if s.name == "messaging.fluvio.consume"]
    assert consume and format(consume[0].context.trace_id, "032x") == _TRACE_ID
