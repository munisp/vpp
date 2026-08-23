"""CLI entry point.

Exits non-zero when any dataset failed. That matters more than it sounds: this is
what makes a Kubernetes CronJob show a failed job, and an alert fire, instead of
the previous script's unconditional success.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time

from .config import ConfigError, load_config
from .datasets import DATASETS, selected
from .pipeline import run
from .store import open_store

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
)
logger = logging.getLogger("lakehouse")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="lakehouse", description=__doc__)
    parser.add_argument(
        "--datasets",
        nargs="*",
        default=[],
        help=f"datasets to ingest (default: all of {', '.join(d.name for d in DATASETS)})",
    )
    parser.add_argument(
        "--max-batches",
        type=int,
        default=20,
        help="batches per dataset per pass; bounds one run's duration",
    )
    parser.add_argument(
        "--loop-seconds",
        type=int,
        default=0,
        help="repeat forever with this delay between passes (for a long-running container; "
        "a CronJob should leave this unset)",
    )
    args = parser.parse_args(argv)

    try:
        config = load_config()
        datasets = selected(args.datasets)
    except (ConfigError, KeyError) as exc:
        logger.error("%s", exc)
        return 2

    store = open_store(config.store)
    logger.info("ingesting %s into %s", ", ".join(d.name for d in datasets), store.describe())

    while True:
        results = run(config, store, datasets, args.max_batches)
        failed = [r for r in results if r.state == "failed"]
        for result in results:
            logger.info(
                "%s: %s (%d rows, %d bytes, %d objects)%s",
                result.dataset,
                result.state,
                result.rows,
                result.bytes_written,
                len(result.objects),
                f" error={result.error}" if result.error else "",
            )
        if not args.loop_seconds:
            return 1 if failed else 0
        time.sleep(args.loop_seconds)


if __name__ == "__main__":
    sys.exit(main())
