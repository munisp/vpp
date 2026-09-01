"""Telemetry: init matrix, /health status field, /metrics, propagation."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from gridmodel import telemetry
from gridmodel.service import app

from factories import feeder_with_transformer

client = TestClient(app)

_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"


def test_disabled_via_escape_hatch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OTEL_SDK_DISABLED", "true")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
    state = telemetry.init_telemetry()
    assert state["enabled"] is False
    assert "OTEL_SDK_DISABLED" in state["reason"]


def test_disabled_when_endpoint_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OTEL_SDK_DISABLED", raising=False)
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    state = telemetry.init_telemetry()
    assert state["enabled"] is False
    assert "OTEL_EXPORTER_OTLP_ENDPOINT" in state["reason"]


def test_health_reports_telemetry_field() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    telemetry_field = response.json()["telemetry"]
    assert telemetry_field["enabled"] in (True, False)
    if not telemetry_field["enabled"]:
        assert telemetry_field["reason"]


def test_metrics_endpoint_exposes_prometheus_text() -> None:
    client.get("/health")  # ensure at least one counted request
    response = client.get("/metrics")
    assert response.status_code == 200
    assert "gridmodel_http_requests_total" in response.text


def test_evaluation_duration_histogram_recorded() -> None:
    body = {
        "network": feeder_with_transformer().model_dump(mode="json"),
        "loads": [{"bus": "LV", "p_w": 50_000.0}],
        "study_reference": "telemetry-study",
    }
    assert client.post("/feasibility", json=body).status_code == 200
    response = client.get("/metrics")
    assert 'gridmodel_evaluation_duration_seconds_count{operation="feasibility"' in response.text


def test_enabled_init_and_traceparent_join(monkeypatch: pytest.MonkeyPatch) -> None:
    """With an endpoint set, init succeeds and an incoming W3C traceparent
    from the TypeScript caller is honoured: the server span continues the
    caller's trace instead of starting a new one."""
    from opentelemetry import trace
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
        InMemorySpanExporter,
    )

    monkeypatch.delenv("OTEL_SDK_DISABLED", raising=False)
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
    monkeypatch.setenv("OTEL_SERVICE_NAME", "gridmodel")
    monkeypatch.setenv("OTEL_TENANT_ID", "tenant-test")

    state = telemetry.init_telemetry()
    assert state == {"enabled": True}

    exporter = InMemorySpanExporter()
    provider = trace.get_tracer_provider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    telemetry.instrument_app(app)

    response = client.get("/health", headers={"traceparent": _TRACEPARENT})
    assert response.status_code == 200

    spans = exporter.get_finished_spans()
    joined = [
        s for s in spans if format(s.context.trace_id, "032x") == "4bf92f3577b34da6a3ce929d0e0e4736"
    ]
    assert joined, "no span continued the caller's trace"
    # The server span is the one directly parented by the caller's span id;
    # the instrumentor may also emit inner (e.g. "http send") spans.
    server_spans = [
        s
        for s in joined
        if s.parent is not None and format(s.parent.span_id, "016x") == "00f067aa0ba902b7"
    ]
    assert server_spans, f"spans in trace: {[(s.name, s.kind) for s in joined]}"

    resource = provider.resource
    assert resource.attributes["service.name"] == "gridmodel"
    assert resource.attributes["tenant.id"] == "tenant-test"
