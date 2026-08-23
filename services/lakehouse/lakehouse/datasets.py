"""What the lakehouse ingests, and how each dataset is ordered.

Two properties matter for every dataset here:

* **A total order to resume from.** Each one names a change column and the row
  id, and the job reads `(change_column, id) > watermark`. The id is not
  decoration: two rows written in the same microsecond would otherwise let a
  watermark on the timestamp alone skip whichever one landed second.

* **Whether a row can change after it is written.** `payments`, `trades` and
  `p2p_settlements` are updated in place (a payment goes pending → completed), so
  their change column is `updatedAt` and the lake accumulates *versions* of a
  row. Readers must take the newest `_change_at` per id; nothing here pretends
  the lake holds one row per entity. The append-only datasets
  (`telemetry`, `settlement_events`, `event_inbox`) never restate a row.

Column lists are explicit rather than `SELECT *`, so a new operational column
does not silently start flowing into the lake, and so the phone numbers and
account numbers on `payments` stay out of it entirely.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence


@dataclass(frozen=True)
class Dataset:
    name: str
    table: str
    #: Column giving each row its position in the ingestion order.
    change_column: str
    #: Monotonic primary key, used to break ties within one change instant.
    id_column: str
    columns: Sequence[str]
    #: True when a row can be updated after insert, so the lake holds versions.
    mutable: bool
    #: What a reader is looking at, in one line — carried into the API surface.
    description: str

    def select_sql(self, *, resume: bool) -> str:
        """The extraction query. Parameters are ($1 change, $2 id, $3 limit) when
        resuming, ($1 limit) on a first run."""
        projected = ", ".join(f'{self.table}."{column}"' for column in self.columns)
        where = ""
        if resume:
            where = (
                f'WHERE ({self.table}."{self.change_column}", {self.table}."{self.id_column}") '
                "> (%s, %s) "
            )
        return (
            f'SELECT {projected}, {self.table}."{self.change_column}" AS _change_at, '
            f'{self.table}."{self.id_column}" AS _row_id '
            f"FROM {self.table} "
            f"{where}"
            f'ORDER BY {self.table}."{self.change_column}", {self.table}."{self.id_column}" '
            "LIMIT %s"
        )

    def backlog_sql(self) -> str:
        """How many rows sit past a given watermark. This is what makes "behind by
        N rows" a measurement rather than an assumption."""
        return (
            f"SELECT COUNT(*) AS behind FROM {self.table} "
            f'WHERE ({self.table}."{self.change_column}", {self.table}."{self.id_column}") '
            "> (%s, %s)"
        )


DATASETS: tuple[Dataset, ...] = (
    Dataset(
        name="telemetry",
        table="telemetry",
        # Rows carry a device `timestamp` that can arrive late or out of order;
        # `createdAt` is when this platform received it, which is the only column
        # that is monotonic with respect to ingestion. Consumers that need event
        # time partition on `timestamp` themselves.
        change_column="createdAt",
        id_column="id",
        columns=(
            "id",
            "assetId",
            "timestamp",
            "power",
            "energy",
            "voltage",
            "current",
            "frequency",
            "stateOfCharge",
            "temperature",
            "createdAt",
        ),
        mutable=False,
        description="Per-asset meter and device samples as received, in receipt order.",
    ),
    Dataset(
        name="payments",
        table="payments",
        change_column="updatedAt",
        id_column="id",
        # `phoneNumber` and `accountNumber` are deliberately absent: the lake is
        # for analysis and model training, and neither needs the subscriber's MSISDN.
        columns=(
            "id",
            "userId",
            "billingId",
            "p2pTradeId",
            "paymentType",
            "amount",
            "currency",
            "paymentMethod",
            "status",
            "createdAt",
            "updatedAt",
        ),
        mutable=True,
        description="Mobile-money payment versions, in status-change order. Amounts are cents.",
    ),
    Dataset(
        name="trades",
        table="trades",
        change_column="updatedAt",
        id_column="id",
        columns=(
            "id",
            "userId",
            "counterpartyId",
            "tradeType",
            "tradingMode",
            "energy",
            "price",
            "totalAmount",
            "status",
            "timestamp",
            "createdAt",
            "updatedAt",
        ),
        mutable=True,
        description="Energy trade versions. `energy` is Wh, `price` and amounts are cents.",
    ),
    Dataset(
        name="p2p_settlements",
        table="p2p_settlements",
        change_column="updatedAt",
        id_column="id",
        columns=(
            "id",
            "buyTradeId",
            "sellTradeId",
            "buyerId",
            "sellerId",
            "energyWh",
            "amountCents",
            "currency",
            "delivery",
            "deliveredEnergyWh",
            "deliverySamples",
            "sellerPayout",
            "state",
            "reconciliation",
            "createdAt",
            "updatedAt",
        ),
        mutable=True,
        description="P2P settlement versions with measured delivery and payout state.",
    ),
    Dataset(
        name="settlement_events",
        table="settlement_events",
        change_column="created_at",
        id_column="id",
        columns=(
            "id",
            "event_hash",
            "previous_hash",
            "sequence_number",
            "event_type",
            "user_id",
            "counterparty_id",
            "source_type",
            "source_id",
            "energy_wh",
            "power_kw",
            "duration_minutes",
            "rate_per_unit",
            "gross_amount",
            "fees",
            "net_amount",
            "currency",
            "measurement_method",
            "verification_status",
            "created_at",
        ),
        mutable=False,
        description="The hash-chained settlement ledger, append-only, in sequence order.",
    ),
    Dataset(
        name="event_inbox",
        table="event_inbox",
        change_column="consumed_at",
        id_column="id",
        columns=(
            "id",
            "topic",
            "event_key",
            "partition",
            "message_offset",
            "payload",
            "produced_at",
            "consumed_at",
        ),
        mutable=False,
        description="Kafka events this platform actually consumed, with producer and consume times.",
    ),
)

BY_NAME = {dataset.name: dataset for dataset in DATASETS}


def selected(names: Sequence[str]) -> tuple[Dataset, ...]:
    """Resolve dataset names, refusing unknown ones instead of ingesting a subset
    the operator did not ask for."""
    if not names:
        return DATASETS
    unknown = [name for name in names if name not in BY_NAME]
    if unknown:
        raise KeyError(f"unknown dataset(s): {', '.join(sorted(unknown))}")
    return tuple(BY_NAME[name] for name in names)
