from datetime import datetime

from vppml import synthetic


START = datetime(2026, 3, 2, 0, 0, 0)


def test_same_seed_regenerates_the_same_fleet_and_series():
    """The seed is the dataset's provenance, so it has to be sufficient on its own."""
    first = synthetic.generate(synthetic.build_fleet(11), start=START, hours=48)
    second = synthetic.generate(synthetic.build_fleet(11), start=START, hours=48)
    assert first == second


def test_a_different_seed_produces_a_different_series():
    first = synthetic.generate(synthetic.build_fleet(11), start=START, hours=48)
    second = synthetic.generate(synthetic.build_fleet(12), start=START, hours=48)
    assert first["power"] != second["power"]


def test_solar_reports_nothing_at_night_and_something_at_noon():
    fleet = synthetic.build_fleet(5, solar_sites=3, battery_sites=0, meter_sites=0)
    columns = synthetic.generate(fleet, start=START, hours=24)
    by_hour: dict[int, list[int]] = {}
    for at, power in zip(columns["timestamp"], columns["power"]):
        by_hour.setdefault(at.hour, []).append(power)
    assert all(value == 0 for value in by_hour[1])
    assert max(by_hour[12]) > 0


def test_battery_state_of_charge_tracks_its_own_power():
    """SoC integrated from the same power the row reports; a model can only learn
    the relationship if the two channels agree."""
    fleet = synthetic.build_fleet(3, solar_sites=0, battery_sites=1, meter_sites=0)
    columns = synthetic.generate(fleet, start=START, hours=48)
    socs = [value for value in columns["stateOfCharge"] if value is not None]
    assert len(socs) == len(columns["stateOfCharge"])
    assert min(socs) >= 0 and max(socs) <= 100
    # It charges during the day and discharges in the evening, so it must move.
    assert max(socs) - min(socs) > 5


def test_solar_and_meter_rows_report_no_state_of_charge():
    fleet = synthetic.build_fleet(9, solar_sites=2, battery_sites=0, meter_sites=2)
    columns = synthetic.generate(fleet, start=START, hours=6)
    assert set(columns["stateOfCharge"]) == {None}


def test_meters_consume_and_solar_exports():
    fleet = synthetic.build_fleet(4, solar_sites=2, battery_sites=0, meter_sites=2)
    columns = synthetic.generate(fleet, start=START, hours=24)
    kinds = synthetic.asset_kinds(fleet)
    for asset_id, power in zip(columns["assetId"], columns["power"]):
        if kinds[asset_id] == "meter":
            assert power <= 0
        if kinds[asset_id] == "solar":
            assert power >= 0


def test_provenance_carries_what_regeneration_needs():
    fleet = synthetic.build_fleet(77)
    provenance = synthetic.provenance(fleet, hours=24, interval_minutes=15)
    assert provenance["seed"] == 77
    assert provenance["generator"] == synthetic.GENERATOR_NAME
    assert provenance["generator_version"] == synthetic.GENERATOR_VERSION


def test_topology_attaches_every_asset_to_a_feeder_under_one_substation():
    fleet = synthetic.build_fleet(21)
    nodes = synthetic.asset_nodes(fleet)
    assert set(nodes) == {asset.asset_id for asset in fleet.assets}
    roots = [node for node, parent in fleet.node_parents.items() if parent is None]
    assert len(roots) == 1
    for node_id in set(nodes.values()):
        assert fleet.node_parents[node_id] == roots[0]
