"""Command line entry points: train, evaluate drift, promote, roll back, run the loop.

    python -m vppml.cli train --origin synthetic --seed 20260101 --hours 720
    python -m vppml.cli train-graph --origin platform --hours 336
    python -m vppml.cli drift --model asset_power_forecast
    python -m vppml.cli promote --model asset_power_forecast --version v3
    python -m vppml.cli rollback --model asset_power_forecast --to v2
    python -m vppml.cli tick

Every command exits non-zero when the platform refused, so a scheduled run that
declined to train is visible in the job's exit status rather than only in a log
line that reads like success.
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from . import continuous, graph_train, registry, train
from .config import Config, ConfigError, load_config
from .distributed import RayUnavailable, compute
from .registry import RegistryError


def _connect(config: Config) -> Any:
    import psycopg2  # noqa: PLC0415

    return psycopg2.connect(config.dsn)


def _window(hours: int, end: Optional[str]) -> tuple[datetime, datetime]:
    finish = (
        datetime.fromisoformat(end)
        if end
        else datetime.now(timezone.utc).replace(tzinfo=None)
    )
    if finish.tzinfo is not None:
        finish = finish.astimezone(timezone.utc).replace(tzinfo=None)
    return finish - timedelta(hours=hours), finish


def _train(args: argparse.Namespace, config: Config) -> int:
    connection = _connect(config)
    window_start, window_end = _window(args.hours, args.end)
    try:
        with compute(config.ray_address) as context:
            print(f"compute: {context.detail}")
            outcome = train.train_forecaster(
                connection,
                config,
                train.TrainingConfig(model_name=args.model, epochs=args.epochs),
                origin=args.origin,
                window_start=window_start,
                window_end=window_end,
                seed=args.seed,
                trigger="manual",
                compute=context.label,
            )
    except RayUnavailable as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 3
    finally:
        connection.close()

    print(f"{outcome.state}: {outcome.detail or outcome.refusal_reason or outcome.error}")
    return 0 if outcome.state == "succeeded" else 4


def _train_graph(args: argparse.Namespace, config: Config) -> int:
    connection = _connect(config)
    window_start, window_end = _window(args.hours, args.end)
    try:
        with compute(config.ray_address) as context:
            print(f"compute: {context.detail}")
            outcome = graph_train.train_topology_gnn(
                connection,
                config,
                graph_train.GraphTrainingConfig(model_name=args.model, epochs=args.epochs),
                origin=args.origin,
                window_start=window_start,
                window_end=window_end,
                seed=args.seed,
                trigger="manual",
                compute=context.label,
            )
    except RayUnavailable as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 3
    finally:
        connection.close()

    print(f"{outcome.state}: {outcome.detail or outcome.refusal_reason or outcome.error}")
    return 0 if outcome.state == "succeeded" else 4


def _drift(args: argparse.Namespace, config: Config) -> int:
    connection = _connect(config)
    try:
        version = registry.production_version(connection, args.model)
        if version is None:
            print(f"{args.model} has no production version", file=sys.stderr)
            return 4
        report, performance = continuous.evaluate_drift(
            connection, config, model_id=version.id, model_name=args.model
        )
        print(f"drift: {report.state} ({report.severity}) — {report.detail}")
        for item in report.drifted:
            print(
                f"  {item.feature}: PSI {item.psi:.3f}, mean shift {item.mean_shift:.2f}σ "
                f"({item.severity})"
            )
        print(f"performance: {performance.state} — {performance.detail}")
        trigger = continuous.should_retrain(report, performance)
        print(f"retrain trigger: {trigger or 'none'}")
    finally:
        connection.close()
    return 0


def _promote(args: argparse.Namespace, config: Config) -> int:
    connection = _connect(config)
    try:
        version = registry.promote(connection, args.model, args.version, actor=args.actor)
        print(f"{version.model_name} {version.model_version} is production ({version.artifact_path})")
    except RegistryError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 4
    finally:
        connection.close()
    return 0


def _rollback(args: argparse.Namespace, config: Config) -> int:
    connection = _connect(config)
    try:
        version = registry.rollback(connection, args.model, args.to, actor=args.actor)
        print(f"rolled back: {version.model_name} {version.model_version} is production")
    except RegistryError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 4
    finally:
        connection.close()
    return 0


def _tick(args: argparse.Namespace, config: Config) -> int:
    connection = _connect(config)
    try:
        results = continuous.tick(connection, config)
    finally:
        connection.close()
    if not results:
        print("no retraining was needed or claimable")
        return 0
    failed = 0
    for result in results:
        print(f"{result.job_id}: {result.status} — {result.detail}")
        if result.status == "failed":
            failed += 1
    return 5 if failed else 0


def main(argv: Optional[list[str]] = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    parser = argparse.ArgumentParser(prog="vppml")
    subparsers = parser.add_subparsers(dest="command", required=True)

    for name, handler in (("train", _train), ("train-graph", _train_graph)):
        sub = subparsers.add_parser(name)
        sub.add_argument(
            "--origin",
            choices=("platform", "lakehouse", "synthetic"),
            required=True,
            help="where the training data comes from; there is no fallback between them",
        )
        sub.add_argument("--model", default=None)
        sub.add_argument("--hours", type=int, default=24 * 14)
        sub.add_argument("--end", default=None, help="ISO timestamp; defaults to now (UTC)")
        sub.add_argument("--seed", type=int, default=None, help="required for --origin synthetic")
        sub.add_argument("--epochs", type=int, default=30)
        sub.set_defaults(handler=handler)

    sub = subparsers.add_parser("drift")
    sub.add_argument("--model", required=True)
    sub.set_defaults(handler=_drift)

    sub = subparsers.add_parser("promote")
    sub.add_argument("--model", required=True)
    sub.add_argument("--version", required=True)
    sub.add_argument("--actor", default="cli")
    sub.set_defaults(handler=_promote)

    sub = subparsers.add_parser("rollback")
    sub.add_argument("--model", required=True)
    sub.add_argument("--to", required=True)
    sub.add_argument("--actor", default="cli")
    sub.set_defaults(handler=_rollback)

    sub = subparsers.add_parser("tick")
    sub.set_defaults(handler=_tick)

    args = parser.parse_args(argv)
    if getattr(args, "model", None) is None:
        args.model = (
            "feeder_power_forecast" if args.command == "train-graph" else "asset_power_forecast"
        )

    try:
        config = load_config()
    except ConfigError as exc:
        print(f"configuration: {exc}", file=sys.stderr)
        return 2
    return int(args.handler(args, config))


if __name__ == "__main__":
    raise SystemExit(main())
