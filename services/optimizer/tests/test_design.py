"""Tests for the design (sizing) study.

The properties that matter for a study that ends up in a board pack or a
grant application:

* the same request always produces the same answer
* a figure with no input behind it is refused, not defaulted
* a limit that cannot be met produces no recommendation, not the least-bad one
* LCOE and payback are null where their denominators do not exist, never zero
* the arithmetic is the arithmetic (checked by hand on a case small enough to)
"""

from __future__ import annotations

import math

import pytest
from pydantic import ValidationError

from optimizer.design import run_design_study
from optimizer.design_schemas import (
    BackupSource,
    DesignRequest,
    DesignStatus,
    Economics,
    LoadProfile,
    ProfileSource,
    ResourceProfile,
    SizingSweep,
)
from optimizer.schemas import SolveStatus

# A day of hourly values: flat 10 kW load, a solar curve peaking at midday.
FLAT_LOAD_W = [10_000.0] * 24
SOLAR_CF = [
    0.0, 0.0, 0.0, 0.0, 0.0, 0.02, 0.10, 0.25,
    0.45, 0.62, 0.76, 0.85, 0.88, 0.85, 0.76, 0.62,
    0.45, 0.25, 0.10, 0.02, 0.0, 0.0, 0.0, 0.0,
]


def design_request(**overrides) -> DesignRequest:
    payload = {
        "interval_minutes": 60,
        "load": LoadProfile(source=ProfileSource.METERED, load_w=list(FLAT_LOAD_W)),
        "resources": [
            ResourceProfile(
                kind="solar_pv",
                source=ProfileSource.SOURCED,
                capacity_factor=list(SOLAR_CF),
                reference="NASA POWER 2019-2023",
            )
        ],
        "backup": BackupSource(
            kind="genset",
            max_w=15_000.0,
            energy_cost_cents_per_kwh=45.0,
            fuel_litres_per_kwh=0.33,
            emissions_g_per_kwh=2_680.0,
        ),
        "economics": Economics(
            discount_rate_percent=12.0,
            project_years=20,
            pv_capex_cents_per_kw=90_000.0,
            battery_capex_cents_per_kwh=35_000.0,
            fixed_opex_percent_of_capex_per_year=2.0,
        ),
        "sweep": SizingSweep(pv_kw=[0.0, 20.0, 40.0], battery_kwh=[0.0, 40.0, 80.0]),
        "max_unmet_fraction": 0.02,
        "dispatch_check": False,
    }
    payload.update(overrides)
    return DesignRequest(**payload)


class TestValidation:
    def test_a_study_with_no_load_is_refused(self):
        with pytest.raises(ValidationError):
            LoadProfile(source=ProfileSource.METERED, load_w=[])

    def test_a_load_of_all_zeroes_is_refused(self):
        with pytest.raises(ValidationError, match="nothing to design for"):
            LoadProfile(source=ProfileSource.DECLARED, load_w=[0.0] * 24)

    def test_a_negative_load_is_refused(self):
        with pytest.raises(ValidationError, match="cannot be negative"):
            LoadProfile(source=ProfileSource.METERED, load_w=[1.0] * 23 + [-1.0])

    def test_a_resource_series_must_cover_the_load(self):
        with pytest.raises(ValidationError, match="capacity_factor has 12 entries"):
            design_request(
                resources=[
                    ResourceProfile(
                        kind="solar_pv",
                        source=ProfileSource.SOURCED,
                        capacity_factor=SOLAR_CF[:12],
                    )
                ]
            )

    def test_a_genset_without_fuel_intensity_is_refused(self):
        with pytest.raises(ValidationError, match="fuel_litres_per_kwh"):
            BackupSource(kind="genset", max_w=1.0, energy_cost_cents_per_kwh=1.0)

    def test_sizing_wind_without_a_wind_profile_is_refused(self):
        with pytest.raises(ValidationError, match="sizes wind"):
            design_request(sweep=SizingSweep(pv_kw=[0.0], battery_kwh=[0.0], wind_kw=[50.0]))

    def test_backup_availability_must_cover_the_profile(self):
        with pytest.raises(ValidationError, match="every interval"):
            design_request(
                backup=BackupSource(
                    kind="grid",
                    max_w=15_000.0,
                    energy_cost_cents_per_kwh=20.0,
                    available=[True] * 12,
                )
            )

    def test_an_oversized_sweep_is_refused_rather_than_truncated(self):
        with pytest.raises(ValidationError, match="exceeds the 400 limit"):
            SizingSweep(
                pv_kw=[float(step) for step in range(21)],
                battery_kwh=[float(step) for step in range(21)],
            )

    def test_a_misspelled_assumption_is_refused_rather_than_defaulted(self):
        # A key nobody reads would leave capex at its default and quietly change
        # LCOE and payback, so the request is rejected instead.
        with pytest.raises(ValidationError, match="backup_capex_cents"):
            Economics(
                discount_rate_percent=12.0,
                project_years=20,
                pv_capex_cents_per_kw=90_000.0,
                battery_capex_cents_per_kwh=35_000.0,
                backup_capex_cents=250_000.0,
            )

    def test_an_unknown_top_level_key_is_refused(self):
        with pytest.raises(ValidationError, match="diesel_price"):
            design_request(diesel_price=100.0)

    def test_a_partial_day_profile_is_refused(self):
        with pytest.raises(ValidationError, match="whole number of days"):
            design_request(
                load=LoadProfile(source=ProfileSource.METERED, load_w=[1_000.0] * 30),
                resources=[
                    ResourceProfile(
                        kind="solar_pv",
                        source=ProfileSource.SOURCED,
                        capacity_factor=[0.5] * 30,
                    )
                ],
            )


class TestStudy:
    def test_identical_requests_produce_identical_studies(self):
        first = run_design_study(design_request())
        second = run_design_study(design_request())
        assert first.model_dump() == second.model_dump()

    def test_the_baseline_is_the_genset_carrying_the_whole_load(self):
        response = run_design_study(design_request())
        baseline = response.baseline
        # 10 kW flat for 24 h = 240 kWh/day, every kWh from the genset.
        assert baseline.served_kwh_per_year == pytest.approx(240 * 365)
        assert baseline.unmet_kwh_per_year == pytest.approx(0.0)
        assert baseline.fuel_litres_per_year == pytest.approx(240 * 365 * 0.33)
        assert baseline.emissions_kg_per_year == pytest.approx(240 * 365 * 2.68)
        assert baseline.annual_energy_cents == pytest.approx(240 * 365 * 45.0)
        # No capex, so levelised cost is exactly the fuel price per kWh.
        assert baseline.lcoe_cents_per_kwh == pytest.approx(45.0)

    def test_the_do_nothing_candidate_reproduces_the_baseline(self):
        response = run_design_study(design_request())
        nothing = next(
            candidate
            for candidate in response.candidates
            if candidate.pv_kw == 0 and candidate.battery_kwh == 0
        )
        assert nothing.backup_kwh_per_year == pytest.approx(response.baseline.served_kwh_per_year)
        assert nothing.renewable_kwh_per_year == pytest.approx(0.0)
        assert nothing.payback_years is None, "the baseline cannot pay itself back"

    def test_solar_displaces_fuel_and_the_recommendation_is_the_cheapest_feasible(self):
        response = run_design_study(design_request())
        assert response.status is DesignStatus.OPTIMAL
        recommended = response.recommended
        assert recommended is not None
        assert recommended.meets_unmet_limit
        assert recommended.backup_kwh_per_year < response.baseline.served_kwh_per_year
        assert recommended.fuel_litres_per_year is not None
        assert recommended.fuel_litres_per_year < response.baseline.fuel_litres_per_year
        cheapest = min(
            candidate.lcoe_cents_per_kwh
            for candidate in response.candidates
            if candidate.meets_unmet_limit and candidate.lcoe_cents_per_kwh is not None
        )
        assert recommended.lcoe_cents_per_kwh == pytest.approx(cheapest)

    def test_energy_balances_over_every_candidate(self):
        response = run_design_study(design_request())
        for candidate in response.candidates:
            assert candidate.served_kwh_per_year + candidate.unmet_kwh_per_year == pytest.approx(
                candidate.demand_kwh_per_year
            )
            # Renewable output either serves load, charges the battery (and is
            # served later) or is curtailed; nothing appears from nowhere. This
            # is what the warm-up pass buys: a battery assumed half full at hour
            # zero would break this on every candidate that has storage.
            assert candidate.renewable_kwh_per_year + candidate.backup_kwh_per_year >= (
                candidate.served_kwh_per_year - 1e-6
            )

    def test_a_dearer_diesel_price_shortens_payback(self):
        cheap = run_design_study(design_request())
        dear = run_design_study(
            design_request(
                backup=BackupSource(
                    kind="genset",
                    max_w=15_000.0,
                    energy_cost_cents_per_kwh=90.0,
                    fuel_litres_per_kwh=0.33,
                    emissions_g_per_kwh=2_680.0,
                )
            )
        )
        cheap_pv = next(c for c in cheap.candidates if c.pv_kw == 40.0 and c.battery_kwh == 80.0)
        dear_pv = next(c for c in dear.candidates if c.pv_kw == 40.0 and c.battery_kwh == 80.0)
        assert cheap_pv.payback_years is not None and dear_pv.payback_years is not None
        assert dear_pv.payback_years < cheap_pv.payback_years
        # Fuel displaced is unchanged; only what it was worth changed.
        assert dear_pv.fuel_litres_per_year == pytest.approx(cheap_pv.fuel_litres_per_year)

    def test_no_candidate_can_meet_an_unmeetable_limit(self):
        # The genset cannot cover the load, no candidate carries it, and zero
        # unserved energy is demanded: there is no recommendation to give.
        response = run_design_study(
            design_request(
                backup=BackupSource(
                    kind="genset",
                    max_w=2_000.0,
                    energy_cost_cents_per_kwh=45.0,
                    fuel_litres_per_kwh=0.33,
                ),
                sweep=SizingSweep(pv_kw=[0.0, 5.0], battery_kwh=[0.0]),
                max_unmet_fraction=0.0,
            )
        )
        assert response.status is DesignStatus.NO_FEASIBLE_CANDIDATE
        assert response.recommended is None
        assert response.reason is not None and "unserved" in response.reason
        assert response.candidates, "the candidates that missed are still reported"
        assert not any(candidate.meets_unmet_limit for candidate in response.candidates)
        assert response.dispatch_check.ran is False

    def test_a_candidate_that_serves_nothing_has_no_lcoe_and_no_payback(self):
        # A grid that is never available, no storage and no PV: nothing is
        # served, so there is no energy to divide cost by. Zero would read as
        # free power.
        response = run_design_study(
            design_request(
                backup=BackupSource(
                    kind="grid",
                    max_w=15_000.0,
                    energy_cost_cents_per_kwh=20.0,
                    available=[False] * 24,
                ),
                sweep=SizingSweep(pv_kw=[0.0], battery_kwh=[0.0]),
                max_unmet_fraction=1.0,
            )
        )
        candidate = response.candidates[0]
        assert candidate.served_kwh_per_year == pytest.approx(0.0)
        assert candidate.lcoe_cents_per_kwh is None
        assert candidate.payback_years is None
        assert candidate.meets_unmet_limit is False
        assert response.status is DesignStatus.NO_FEASIBLE_CANDIDATE
        assert response.baseline.lcoe_cents_per_kwh is None

    def test_grid_backup_reports_no_fuel_and_no_carbon_it_cannot_know(self):
        response = run_design_study(
            design_request(
                backup=BackupSource(
                    kind="grid", max_w=15_000.0, energy_cost_cents_per_kwh=20.0
                ),
                max_unmet_fraction=0.5,
            )
        )
        assert response.baseline.fuel_litres_per_year is None
        assert response.baseline.emissions_kg_per_year is None
        assert all(candidate.fuel_litres_per_year is None for candidate in response.candidates)

    def test_a_tariff_is_the_only_source_of_revenue(self):
        without = run_design_study(design_request())
        assert all(c.annual_revenue_cents is None for c in without.candidates)
        with_tariff = run_design_study(design_request(tariff_cents_per_kwh=60.0))
        candidate = with_tariff.candidates[-1]
        assert candidate.annual_revenue_cents == pytest.approx(
            candidate.served_kwh_per_year * 60.0
        )


class TestProvenance:
    def test_the_study_says_where_its_series_came_from(self):
        response = run_design_study(design_request())
        provenance = response.provenance
        assert provenance.load_source is ProfileSource.METERED
        assert provenance.resource_sources == {"solar_pv": ProfileSource.SOURCED}
        assert provenance.resource_references == {"solar_pv": "NASA POWER 2019-2023"}
        assert provenance.backup_availability == "assumed_always_available"

    def test_a_synthetic_profile_is_labelled_as_one(self):
        response = run_design_study(
            design_request(
                load=LoadProfile(
                    source=ProfileSource.SYNTHETIC,
                    load_w=list(FLAT_LOAD_W),
                    reference="clinic archetype v2",
                )
            )
        )
        assert response.provenance.load_source is ProfileSource.SYNTHETIC
        assert response.provenance.load_reference == "clinic archetype v2"

    def test_declared_backup_availability_is_not_reported_as_assumed(self):
        response = run_design_study(
            design_request(
                backup=BackupSource(
                    kind="grid",
                    max_w=15_000.0,
                    energy_cost_cents_per_kwh=20.0,
                    available=[True] * 18 + [False] * 6,
                ),
                max_unmet_fraction=0.5,
            )
        )
        assert response.provenance.backup_availability == "declared_per_interval"

    def test_a_single_day_study_says_its_year_is_extrapolated(self):
        response = run_design_study(design_request())
        assert response.provenance.days_simulated == pytest.approx(1.0)
        assert response.provenance.annualisation_factor == pytest.approx(365.0)
        assert any("extrapolation" in note for note in response.provenance.notes)

    def test_a_two_day_profile_is_annualised_from_two_days(self):
        response = run_design_study(
            design_request(
                load=LoadProfile(source=ProfileSource.METERED, load_w=FLAT_LOAD_W * 2),
                resources=[
                    ResourceProfile(
                        kind="solar_pv",
                        source=ProfileSource.SOURCED,
                        capacity_factor=SOLAR_CF * 2,
                    )
                ],
            )
        )
        assert response.provenance.days_simulated == pytest.approx(2.0)
        assert response.provenance.annualisation_factor == pytest.approx(182.5)
        assert response.baseline.served_kwh_per_year == pytest.approx(240 * 365)


class TestDispatchCheck:
    def test_the_existing_milp_checks_the_hardest_day(self):
        response = run_design_study(design_request(dispatch_check=True))
        check = response.dispatch_check
        assert check.ran is True
        assert check.status is SolveStatus.OPTIMAL
        assert check.day_index == 0
        assert check.rule_based_unserved_wh is not None
        assert check.optimised_unserved_wh is not None
        # The MILP has foresight the priority rule does not, so it can never do
        # worse on unserved energy.
        assert check.optimised_unserved_wh <= check.rule_based_unserved_wh + 1e-6

    def test_a_backup_that_comes_and_goes_is_not_checked_against_one_import_limit(self):
        response = run_design_study(
            design_request(
                backup=BackupSource(
                    kind="grid",
                    max_w=15_000.0,
                    energy_cost_cents_per_kwh=20.0,
                    available=[True] * 18 + [False] * 6,
                ),
                max_unmet_fraction=0.5,
                dispatch_check=True,
            )
        )
        check = response.dispatch_check
        assert check.ran is False
        assert check.reason is not None and "one import limit" in check.reason
        assert check.status is None

    def test_no_check_is_claimed_when_none_was_asked_for(self):
        response = run_design_study(design_request(dispatch_check=False))
        assert response.dispatch_check.ran is False
        assert response.dispatch_check.status is None


class TestArithmetic:
    def test_a_battery_only_case_is_the_arithmetic_by_hand(self):
        # 1 kW flat load, no renewable resource at all beyond a PV profile that
        # is never sized, a genset available for the first 12 hours only, and a
        # 4 kWh battery at 100% round trip with all of it usable.
        response = run_design_study(
            design_request(
                load=LoadProfile(source=ProfileSource.DECLARED, load_w=[1_000.0] * 24),
                resources=[
                    ResourceProfile(
                        kind="solar_pv",
                        source=ProfileSource.DECLARED,
                        capacity_factor=[0.5] * 24,
                    )
                ],
                backup=BackupSource(
                    kind="genset",
                    max_w=1_000.0,
                    energy_cost_cents_per_kwh=50.0,
                    fuel_litres_per_kwh=0.4,
                    available=[True] * 12 + [False] * 12,
                ),
                sweep=SizingSweep(
                    pv_kw=[0.0],
                    battery_kwh=[4.0],
                    battery_power_ratio=1.0,
                    battery_round_trip_efficiency=1.0,
                    battery_usable_fraction=1.0,
                ),
                max_unmet_fraction=1.0,
                dispatch_check=False,
            )
        )
        candidate = response.candidates[0]
        # No PV is installed, so the battery never charges: the warm-up pass
        # empties it and the accounted pass therefore starts empty. Every hour
        # the genset is up is served by the genset (12 kWh), and the 12 hours it
        # is down are unserved. Nothing is served out of a phantom charge.
        assert candidate.renewable_kwh_per_year == pytest.approx(0.0)
        assert candidate.backup_kwh_per_year == pytest.approx(12 * 365)
        assert candidate.unmet_kwh_per_year == pytest.approx(12 * 365)
        assert candidate.served_kwh_per_year == pytest.approx(12 * 365)
        assert candidate.unmet_fraction == pytest.approx(0.5)
        assert candidate.fuel_litres_per_year == pytest.approx(12 * 365 * 0.4)
        assert candidate.annual_fuel_cents == pytest.approx(12 * 365 * 50.0)

    def test_storage_is_not_credited_with_energy_the_profile_never_generated(self):
        # PV that only ever charges the battery, and a load that only runs at
        # night: over a repeating day the battery can hand over what it took in,
        # and no more.
        response = run_design_study(
            design_request(
                load=LoadProfile(source=ProfileSource.DECLARED, load_w=[0.0] * 12 + [1_000.0] * 12),
                resources=[
                    ResourceProfile(
                        kind="solar_pv",
                        source=ProfileSource.DECLARED,
                        capacity_factor=[0.5] * 12 + [0.0] * 12,
                    )
                ],
                backup=BackupSource(
                    kind="genset",
                    max_w=1_000.0,
                    energy_cost_cents_per_kwh=50.0,
                    fuel_litres_per_kwh=0.4,
                    available=[False] * 24,
                ),
                sweep=SizingSweep(
                    pv_kw=[1.0],
                    battery_kwh=[20.0],
                    battery_power_ratio=1.0,
                    battery_round_trip_efficiency=1.0,
                    battery_usable_fraction=1.0,
                ),
                max_unmet_fraction=1.0,
                dispatch_check=False,
            )
        )
        candidate = response.candidates[0]
        # 1 kW at 0.5 for 12 hours is 6 kWh in; 6 kWh comes back out and the
        # remaining 6 kWh of night load is unserved.
        assert candidate.renewable_kwh_per_year == pytest.approx(6 * 365)
        assert candidate.backup_kwh_per_year == pytest.approx(0.0)
        assert candidate.served_kwh_per_year == pytest.approx(6 * 365)
        assert candidate.unmet_kwh_per_year == pytest.approx(6 * 365)

    def test_curtailment_is_energy_the_site_could_not_use_or_store(self):
        # 10 kW of PV at a flat 0.5 capacity factor against a 1 kW load, with
        # no storage: 4 kW of every hour is spilled.
        response = run_design_study(
            design_request(
                load=LoadProfile(source=ProfileSource.DECLARED, load_w=[1_000.0] * 24),
                resources=[
                    ResourceProfile(
                        kind="solar_pv",
                        source=ProfileSource.DECLARED,
                        capacity_factor=[0.5] * 24,
                    )
                ],
                sweep=SizingSweep(pv_kw=[10.0], battery_kwh=[0.0]),
                max_unmet_fraction=0.0,
                dispatch_check=False,
            )
        )
        candidate = response.candidates[0]
        assert candidate.renewable_kwh_per_year == pytest.approx(5 * 24 * 365)
        assert candidate.curtailed_kwh_per_year == pytest.approx(4 * 24 * 365)
        assert candidate.backup_kwh_per_year == pytest.approx(0.0)
        assert candidate.unmet_kwh_per_year == pytest.approx(0.0)
        assert candidate.renewable_fraction_of_served == pytest.approx(1.0)

    def test_levelised_cost_is_discounted_cost_over_discounted_energy(self):
        response = run_design_study(
            design_request(
                sweep=SizingSweep(pv_kw=[0.0], battery_kwh=[0.0]),
                max_unmet_fraction=0.0,
            )
        )
        candidate = response.candidates[0]
        economics = design_request().economics
        rate = economics.discount_rate_percent / 100.0
        factors = [1.0 / ((1.0 + rate) ** year) for year in range(1, economics.project_years + 1)]
        annual = candidate.annual_fixed_opex_cents + candidate.annual_fuel_cents
        expected = (
            candidate.capex_cents + sum(annual * factor for factor in factors)
        ) / sum(candidate.served_kwh_per_year * factor for factor in factors)
        assert candidate.lcoe_cents_per_kwh == pytest.approx(expected)
        assert not math.isnan(candidate.lcoe_cents_per_kwh)
