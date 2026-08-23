import builtins
import os
import subprocess
import sys

import pytest

from vppml import distributed
from vppml.distributed import RayUnavailable


def test_an_unset_ray_address_is_recorded_as_local_not_as_a_cluster():
    with distributed.compute("local") as context:
        assert context.mode == "local"
        assert context.label == "local"
        assert "no Ray cluster" in context.detail


def test_an_address_this_install_cannot_dial_refuses_rather_than_training_locally():
    """`ray://` needs `ray[client]`; without it the address cannot be dialled at all.

    The failure mode this exists to prevent: a run labelled `ray:...` that in fact ran
    in one process, because `ray.init` fell back to starting a local cluster.
    """
    with pytest.raises(RayUnavailable) as raised:
        with distributed.compute("ray://127.0.0.1:10001", connect_timeout=20):
            pass
    assert "not silently downgraded to local" in str(raised.value)


def test_a_cluster_that_never_answers_ends_the_run_instead_of_hanging():
    """A retraining job parked forever inside `ray.init` looks exactly like one that
    is training, so the connect carries a deadline."""
    with pytest.raises(RayUnavailable, match="did not answer within 2s"):
        with distributed.compute("10.255.255.1:6399", connect_timeout=2):
            pass


def test_a_missing_ray_package_refuses_rather_than_falling_back(monkeypatch):
    real_import = builtins.__import__

    def without_ray(name, *args, **kwargs):
        if name == "ray":
            raise ImportError("no module named ray")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", without_ray)
    with pytest.raises(RayUnavailable, match="ray package is not installed"):
        with distributed.compute("ray://cluster:10001", connect_timeout=1):
            pass


def test_local_mapping_runs_every_item_in_process():
    assert distributed.map_windows("local", lambda value: value * 2, [1, 2, 3]) == [2, 4, 6]


def test_mapping_onto_an_unreachable_cluster_refuses(monkeypatch):
    monkeypatch.setattr(distributed, "CONNECT_TIMEOUT_SECONDS", 2.0)
    with pytest.raises(RayUnavailable):
        distributed.map_windows("10.255.255.1:6399", lambda value: value, [1])


@pytest.fixture(scope="module")
def head_address():
    """A Ray head node in its own processes, not a cluster this test process owns.

    `ray.init()` inside the test would be the substitution the module refuses to make
    — a local runtime dressed as a cluster — so the head is started with the CLI and
    `compute()` has to connect to it over the network like a worker would.
    """
    pytest.importorskip("ray")
    ray_cli = os.path.join(os.path.dirname(sys.executable), "ray")
    if not os.path.exists(ray_cli):
        pytest.skip("ray CLI is not installed in this environment")
    started = subprocess.run(
        [ray_cli, "start", "--head", "--num-cpus=2", "--port=6399", "--include-dashboard=false"],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if started.returncode != 0:
        pytest.skip(f"could not start a Ray head node here: {started.stderr[-400:]}")
    try:
        yield "127.0.0.1:6399"
    finally:
        subprocess.run([ray_cli, "stop", "--force"], capture_output=True, timeout=300)


def test_a_real_ray_cluster_reports_its_own_resources(head_address):
    with distributed.compute(head_address) as context:
        assert context.mode == "ray"
        assert context.label.startswith(f"ray:{head_address}@")
        assert "1 live node(s) and 2 CPU(s)" in context.detail


def test_work_dispatched_to_a_real_cluster_runs_in_the_cluster(head_address):
    """The returned pids prove the work left this process; that is the difference
    between a `ray:` label and distributed execution."""
    results = distributed.map_windows(head_address, lambda value: (value + 1, os.getpid()), [1, 2])
    assert [value for value, _ in results] == [2, 3]
    assert all(pid != os.getpid() for _, pid in results)


def test_a_run_needing_more_cpus_than_the_cluster_has_is_refused(head_address):
    with pytest.raises(RayUnavailable, match="fewer than the"):
        with distributed.compute(head_address, expected_cpus=64):
            pass
