"""HTTP contract: failures must not be dressed up as successful plans."""

from __future__ import annotations

import pytest
from factories import battery_asset, request_with
from fastapi.testclient import TestClient

from optimizer.service import app

client = TestClient(app)


def _dispatch_body(**kwargs) -> dict:
    return request_with(**kwargs).model_dump(mode="json")


def test_health_reports_the_solver_in_use():
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["solver"] in body["available_solvers"]


def test_dispatch_returns_a_schedule():
    response = client.post(
        "/optimize/dispatch",
        json=_dispatch_body(
            load_w=[1_000, 1_000],
            import_prices=[10.0, 40.0],
            assets=[battery_asset(initial_soc_percent=80.0)],
        ),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "optimal"
    assert len(body["intervals"]) == 2


def test_infeasible_request_is_422_with_no_schedule():
    response = client.post(
        "/optimize/dispatch",
        json=_dispatch_body(
            load_w=[0.0],
            import_prices=[10.0],
            assets=[
                battery_asset(
                    capacity_wh=100_000,
                    max_charge_w=100,
                    initial_soc_percent=20.0,
                    terminal_soc_percent=95.0,
                )
            ],
        ),
    )
    assert response.status_code == 422
    assert response.json()["detail"]["status"] == "infeasible"


def test_invalid_request_is_rejected():
    response = client.post(
        "/optimize/dispatch",
        json={"interval_minutes": 60, "site": {"site_id": "s"}, "prices": {}},
    )
    assert response.status_code == 422


def test_token_is_enforced_when_configured(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OPTIMIZER_AUTH_TOKEN", "s3cret")
    body = _dispatch_body(load_w=[1_000], import_prices=[10.0])

    assert client.post("/optimize/dispatch", json=body).status_code == 401
    assert (
        client.post(
            "/optimize/dispatch", json=body, headers={"x-optimizer-token": "wrong"}
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/optimize/dispatch", json=body, headers={"x-optimizer-token": "s3cret"}
        ).status_code
        == 200
    )


def test_production_without_a_token_fails_closed(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("OPTIMIZER_AUTH_TOKEN", raising=False)
    monkeypatch.setenv("OPTIMIZER_ENV", "production")
    response = client.post(
        "/optimize/dispatch", json=_dispatch_body(load_w=[1_000], import_prices=[10.0])
    )
    assert response.status_code == 500
    assert "OPTIMIZER_AUTH_TOKEN" in response.json()["detail"]
