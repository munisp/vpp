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


def _design_body() -> dict:
    return {
        "interval_minutes": 60,
        "load": {"source": "metered", "load_w": [5_000.0] * 24},
        "resources": [
            {
                "kind": "solar_pv",
                "source": "sourced",
                "capacity_factor": [0.0] * 6 + [0.5] * 12 + [0.0] * 6,
            }
        ],
        "backup": {
            "kind": "genset",
            "max_w": 8_000.0,
            "energy_cost_cents_per_kwh": 45.0,
            "fuel_litres_per_kwh": 0.33,
        },
        "economics": {
            "discount_rate_percent": 12.0,
            "project_years": 20,
            "pv_capex_cents_per_kw": 90_000.0,
            "battery_capex_cents_per_kwh": 35_000.0,
        },
        "sweep": {"pv_kw": [0.0, 10.0], "battery_kwh": [0.0, 20.0]},
        "max_unmet_fraction": 0.05,
        "dispatch_check": False,
    }


def test_design_study_returns_a_sizing_with_its_provenance():
    response = client.post("/design/study", json=_design_body())
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "optimal"
    assert body["recommended"] is not None
    assert body["baseline"]["kind"] == "genset"
    assert body["provenance"]["load_source"] == "metered"
    assert body["provenance"]["backup_availability"] == "assumed_always_available"


def test_a_design_study_missing_an_assumption_is_rejected_not_defaulted():
    # No tolerance for unserved energy stated, and no cost of diesel: both are
    # answers the caller has to give, not ones the service may pick.
    body = _design_body()
    del body["max_unmet_fraction"]
    del body["backup"]["energy_cost_cents_per_kwh"]
    response = client.post("/design/study", json=body)
    assert response.status_code == 422
    fields = {tuple(error["loc"][1:]) for error in response.json()["detail"]}
    assert ("max_unmet_fraction",) in fields
    assert ("backup", "energy_cost_cents_per_kwh") in fields


def test_design_study_enforces_the_token(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OPTIMIZER_AUTH_TOKEN", "s3cret")
    body = _design_body()
    assert client.post("/design/study", json=body).status_code == 401
    assert (
        client.post(
            "/design/study", json=body, headers={"x-optimizer-token": "s3cret"}
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
