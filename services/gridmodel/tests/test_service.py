"""HTTP behaviour: auth, and a status for every outcome rather than an error."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from gridmodel.service import app

from factories import feeder_with_transformer


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


def _body(**overrides: object) -> dict[str, object]:
    request: dict[str, object] = {
        "network": feeder_with_transformer().model_dump(mode="json"),
        "loads": [{"bus": "LV", "p_w": 50_000.0}],
    }
    request.update(overrides)
    return request


def test_health_reports_the_engine(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["engine"] == "pandapower"
    assert payload["engine_version"]


def test_feasibility_returns_a_solved_case(client: TestClient) -> None:
    response = client.post("/feasibility", json=_body(study_reference="study-1"))
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "feasible"
    assert payload["study_reference"] == "study-1"
    assert payload["diagnostics"]["engine"] == "pandapower"


def test_a_model_without_a_source_answers_200_with_model_unavailable(
    client: TestClient,
) -> None:
    """Not a 4xx: the caller must be able to tell "no model" from "not feasible",
    because one labels the decision network-unchecked and the other refuses it."""
    response = client.post(
        "/feasibility",
        json={"network": {"buses": [{"code": "LV", "nominal_kv": 0.415}]}},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "model_unavailable"
    assert payload["reason"]


def test_a_malformed_model_is_rejected(client: TestClient) -> None:
    response = client.post("/feasibility", json={"network": {"buses": []}})
    assert response.status_code == 422


def test_the_token_is_enforced_when_set(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GRIDMODEL_AUTH_TOKEN", "s3cret")
    unauthorised = client.post("/feasibility", json=_body())
    assert unauthorised.status_code == 401

    authorised = client.post(
        "/feasibility", json=_body(), headers={"x-gridmodel-token": "s3cret"}
    )
    assert authorised.status_code == 200


def test_production_without_a_token_refuses_to_answer(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("GRIDMODEL_AUTH_TOKEN", raising=False)
    monkeypatch.setenv("GRIDMODEL_ENV", "production")
    response = client.post("/feasibility", json=_body())
    assert response.status_code == 500
