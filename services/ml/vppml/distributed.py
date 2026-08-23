"""Ray, or a clear statement that Ray is not there.

`RAY_ADDRESS` unset means `local`: this process trains in-process and every run it
writes records `compute='local'`. Set it, and the run must actually connect —
`ray.init(address=...)` with no local fallback, so a misconfigured or unreachable
cluster raises `RayUnavailable` and the run is recorded as refused. The one thing
this module will not do is quietly train locally while the run says `ray:...`,
because then "distributed training" is a string in a database.

`ray.init(address="auto")` and `ray.init()` both *start a local cluster* when they
cannot find one, which is precisely the silent substitution to avoid; the address
is therefore passed through verbatim and `ignore_reinit_error=False` keeps a second
init from attaching to whatever the first one created.

Connecting is also given a deadline. Ray's own client connect retries for minutes
against an address that will never answer, and a retraining job that hangs there is
indistinguishable from one that is training: the deadline turns that into the same
`RayUnavailable` refusal as a rejected connection.
"""

from __future__ import annotations

import logging
import os
import queue
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator, Optional

logger = logging.getLogger(__name__)

#: How long a cluster has to answer before the run is refused.
CONNECT_TIMEOUT_SECONDS = float(os.environ.get("RAY_CONNECT_TIMEOUT_SECONDS", "60"))


class RayUnavailable(RuntimeError):
    """Ray was requested and could not be used. Never downgraded to local."""


@dataclass(frozen=True)
class ComputeContext:
    #: 'local' or 'ray'
    mode: str
    #: What to record in `training_runs.compute`: 'local' or 'ray:<address>@<nodes> node(s)'.
    label: str
    detail: str


def _import_ray() -> Any:
    try:
        import ray  # noqa: PLC0415

        return ray
    except ImportError as exc:
        raise RayUnavailable(
            "RAY_ADDRESS is set but the ray package is not installed in this environment, so no "
            "distributed run is possible. Install ray or unset RAY_ADDRESS to train locally."
        ) from exc


def _connect(ray: Any, address: str, timeout: float) -> None:
    """`ray.init(address=...)` under a deadline.

    The init runs on a daemon thread so that an address which never answers ends the
    run instead of parking it forever. A connection that lands after the deadline is
    left to that thread and to process exit; the run has already been refused, and
    nothing reads the connection.
    """
    outcome: queue.Queue[Optional[BaseException]] = queue.Queue(maxsize=1)

    def connect() -> None:
        try:
            ray.init(address=address, ignore_reinit_error=False, log_to_driver=False)
        except BaseException as exc:  # noqa: BLE001 - reported to the caller below
            outcome.put(exc)
            return
        outcome.put(None)

    thread = threading.Thread(target=connect, name=f"ray-connect-{address}", daemon=True)
    thread.start()
    try:
        error = outcome.get(timeout=timeout)
    except queue.Empty as exc:
        raise RayUnavailable(
            f"the Ray cluster at {address!r} did not answer within {timeout:g}s. Nothing was "
            "trained; this run is not silently downgraded to local execution."
        ) from exc
    if error is not None:
        raise RayUnavailable(
            f"could not connect to the Ray cluster at {address!r}: "
            f"{type(error).__name__}: {error}. Nothing was trained; this run is not silently "
            "downgraded to local execution."
        ) from error


@contextmanager
def compute(
    address: str,
    *,
    expected_cpus: Optional[int] = None,
    connect_timeout: Optional[float] = None,
) -> Iterator[ComputeContext]:
    """Yield the compute context a run should record.

    For `local`, nothing is initialised. For any other address, Ray is connected
    and the cluster's real resources are read back, so the recorded label reflects
    a cluster that answered rather than one that was configured.
    """
    if address == "local":
        yield ComputeContext(
            mode="local",
            label="local",
            detail="trained in this process; no Ray cluster was involved",
        )
        return

    ray = _import_ray()
    _connect(
        ray,
        address,
        CONNECT_TIMEOUT_SECONDS if connect_timeout is None else connect_timeout,
    )

    try:
        nodes = [node for node in ray.nodes() if node.get("Alive")]
        cpus = int(ray.cluster_resources().get("CPU", 0))
        if not nodes or cpus <= 0:
            raise RayUnavailable(
                f"connected to {address!r} but it reports {len(nodes)} live node(s) and {cpus} CPU(s); "
                "there is nothing to distribute onto."
            )
        if expected_cpus is not None and cpus < expected_cpus:
            raise RayUnavailable(
                f"{address!r} offers {cpus} CPU(s), fewer than the {expected_cpus} this run requires."
            )
        yield ComputeContext(
            mode="ray",
            label=f"ray:{address}@{len(nodes)} node(s)/{cpus} cpu(s)",
            detail=f"connected to {address} with {len(nodes)} live node(s) and {cpus} CPU(s)",
        )
    finally:
        try:
            ray.shutdown()
        except Exception:  # noqa: BLE001 - shutdown failures must not mask the run's result
            logger.warning("ray.shutdown() failed after the run", exc_info=True)


def map_windows(address: str, function: Any, items: list[Any]) -> list[Any]:
    """Run `function` over `items`, on Ray when configured, in this process when not.

    Used for the embarrassingly parallel part of continuous training — building one
    dataset per window — rather than for gradient computation, because a single
    fleet's tensors fit in one process and sharding them across a cluster would cost
    more in transfer than it saves.
    """
    if address == "local":
        return [function(item) for item in items]

    with compute(address) as context:
        ray = _import_ray()
        remote = ray.remote(function)
        logger.info("dispatching %d task(s) to %s", len(items), context.label)
        return ray.get([remote.remote(item) for item in items])
