"""
Temporal Trading Worker

Executes automated trading and P2P trading workflows
"""

import asyncio
import os
import json
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional
from dataclasses import dataclass

from temporalio import activity, workflow
from temporalio.client import Client
from temporalio.worker import Worker
import psycopg2
import psycopg2.extras
from psycopg2 import Error

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# Workflow Input/Output Types
@dataclass
class AutomatedTradingInput:
    user_id: int
    asset_id: int
    strategy: str  # 'sell_excess', 'buy_deficit', 'arbitrage'
    max_price: Optional[int] = None
    min_price: Optional[int] = None
    max_quantity: Optional[float] = None


@dataclass
class AutomatedTradingResult:
    success: bool
    trades_executed: int
    total_volume: float
    total_value: int
    error: Optional[str] = None


@dataclass
class P2PTradingInput:
    seller_id: int
    buyer_id: int
    quantity: float
    price_per_kwh: int
    delivery_time: str
    duration: int


@dataclass
class P2PTradingResult:
    success: bool
    trade_id: Optional[int] = None
    settlement_amount: Optional[int] = None
    error: Optional[str] = None


# Database connection
def get_db_connection():
    """Create database connection"""
    try:
        connection = psycopg2.connect(
            host=os.getenv('DB_HOST', 'localhost'),
            port=os.getenv('DB_PORT', '5432'),
            dbname=os.getenv('DB_NAME', 'vpp_platform'),
            user=os.getenv('DB_USER', 'postgres'),
            password=os.getenv('DB_PASSWORD', ''),
            sslmode=os.getenv('DB_SSLMODE', 'require'),
            # timestamp columns hold UTC and NOW() is converted with the
            # session time zone, so the session must be UTC.
            options='-c timezone=UTC',
        )
        return connection
    except Error as e:
        logger.error(f"Database connection error: {e}")
        raise


# Activities
@activity.defn
async def get_available_energy(user_id: int, asset_id: int) -> float:
    """Get available energy for trading by querying telemetry data"""
    logger.info(f"Getting available energy for user {user_id}, asset {asset_id}")
    
    connection = get_db_connection()
    cursor = connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    
    try:
        # Get user's assets (real columns per drizzle/schema.ts: userId, assetType)
        if asset_id > 0:
            cursor.execute(
                'SELECT id, "assetType", capacity FROM assets WHERE "userId" = %s AND id = %s AND status = \'active\'',
                (user_id, asset_id)
            )
        else:
            cursor.execute(
                'SELECT id, "assetType", capacity FROM assets WHERE "userId" = %s AND status = \'active\'',
                (user_id,)
            )

        assets = cursor.fetchall()
        total_available_energy = 0.0

        for asset in assets:
            # Get latest telemetry for this asset
            # (real columns: assetId, power, stateOfCharge, timestamp)
            cursor.execute(
                """SELECT power, "stateOfCharge", timestamp
                   FROM telemetry
                   WHERE "assetId" = %s
                   ORDER BY timestamp DESC
                   LIMIT 1""",
                (asset['id'],)
            )
            telemetry = cursor.fetchone()

            if telemetry:
                # For batteries, use state of charge
                if asset['assetType'] == 'battery' and telemetry.get('stateOfCharge'):
                    # stateOfCharge is percentage * 100, capacity is in Wh
                    available_wh = (telemetry['stateOfCharge'] / 10000) * asset['capacity']
                    total_available_energy += available_wh / 1000  # Convert to kWh
                # For solar/wind, use current power output
                elif asset['assetType'] in ('solar', 'wind') and telemetry.get('power'):
                    # Estimate available energy for next hour based on current power
                    total_available_energy += telemetry['power'] / 1000  # Convert W to kWh

        logger.info(f"Available energy for user {user_id}: {total_available_energy:.2f} kWh")
        return total_available_energy
    except Error as e:
        # A DB error is NOT 'no energy available' — raise so the workflow can
        # distinguish a legitimate 0.0 from an infrastructure failure.
        raise RuntimeError(f"Error getting available energy for user {user_id}: {e}") from e
    finally:
        cursor.close()
        connection.close()


@activity.defn
async def find_matching_orders(strategy: str, price: Optional[int], limit: int = 10) -> list:
    """Find matching trading orders from the trades table"""
    logger.info(f"Finding matching orders for strategy {strategy}")
    
    connection = get_db_connection()
    cursor = connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    
    try:
        # Find pending trades that match the strategy
        # (real columns per drizzle/schema.ts: userId, tradeType, totalAmount)
        if strategy == 'sell_excess':
            # Looking for buyers (import orders)
            if price:
                cursor.execute(
                    """SELECT id, "userId", energy / 1000.0 as quantity, price, "totalAmount"
                       FROM trades
                       WHERE "tradeType" = 'import' AND status = 'pending' AND price >= %s
                       ORDER BY price DESC
                       LIMIT %s""",
                    (price, limit)
                )
            else:
                cursor.execute(
                    """SELECT id, "userId", energy / 1000.0 as quantity, price, "totalAmount"
                       FROM trades
                       WHERE "tradeType" = 'import' AND status = 'pending'
                       ORDER BY price DESC
                       LIMIT %s""",
                    (limit,)
                )
        else:  # buy_deficit or arbitrage
            # Looking for sellers (export orders)
            if price:
                cursor.execute(
                    """SELECT id, "userId", energy / 1000.0 as quantity, price, "totalAmount"
                       FROM trades
                       WHERE "tradeType" = 'export' AND status = 'pending' AND price <= %s
                       ORDER BY price ASC
                       LIMIT %s""",
                    (price, limit)
                )
            else:
                cursor.execute(
                    """SELECT id, "userId", energy / 1000.0 as quantity, price, "totalAmount"
                       FROM trades
                       WHERE "tradeType" = 'export' AND status = 'pending'
                       ORDER BY price ASC
                       LIMIT %s""",
                    (limit,)
                )

        orders = cursor.fetchall()
        logger.info(f"Found {len(orders)} matching orders")
        # [] here means the query SUCCEEDED and found nothing — a legitimate
        # result. DB errors raise instead of masquerading as an empty book.
        return orders
    except Error as e:
        raise RuntimeError(f"Error finding matching orders for strategy {strategy}: {e}") from e
    finally:
        cursor.close()
        connection.close()


@activity.defn
async def create_trade(buyer_id: int, seller_id: int, quantity: float, price: int) -> Optional[int]:
    """Create a trading transaction in the trades table"""
    logger.info(f"Creating trade: {seller_id} -> {buyer_id}, {quantity}kWh @ {price}c/kWh")
    
    connection = get_db_connection()
    cursor = connection.cursor()
    
    try:
        energy_wh = int(quantity * 1000)  # Convert kWh to Wh
        total_amount = int(quantity * price)

        # Real columns per drizzle/schema.ts: userId, tradeType, tradingMode,
        # totalAmount, counterpartyId. tradeType enum: export/import/p2p_sell/p2p_buy.
        # Create seller's trade record (export side)
        cursor.execute(
            """INSERT INTO trades
               ("userId", "tradeType", "tradingMode", energy, price, "totalAmount", timestamp, status, "counterpartyId", metadata)
               VALUES (%s, 'p2p_sell', 'p2p', %s, %s, %s, NOW(), 'pending', %s, %s)
               RETURNING id""",
            (seller_id, energy_wh, price, total_amount, buyer_id,
             json.dumps({"buyer_id": buyer_id, "quantity_kwh": quantity}))
        )
        trade_id = cursor.fetchone()[0]

        # Create buyer's trade record (import side) — 10 columns, 10 values
        cursor.execute(
            """INSERT INTO trades
               ("userId", "tradeType", "tradingMode", energy, price, "totalAmount", timestamp, status, "counterpartyId", metadata)
               VALUES (%s, 'p2p_buy', 'p2p', %s, %s, %s, NOW(), 'pending', %s, %s)""",
            (buyer_id, energy_wh, price, total_amount, seller_id,
             json.dumps({"seller_id": seller_id, "linked_trade_id": trade_id}))
        )

        connection.commit()
        logger.info(f"Trade created: {trade_id}")
        return trade_id
    except Error as e:
        connection.rollback()
        raise RuntimeError(f"Failed to create trade ({seller_id} -> {buyer_id}): {e}") from e
    finally:
        cursor.close()
        connection.close()


@activity.defn
async def update_order_status(order_id: int, quantity_filled: float) -> bool:
    """Atomically apply one positive fill to a pending order.

    The predicate protects against duplicate delivery and concurrent workers: the
    update succeeds only while the order is pending and still contains the full
    requested quantity. A stale or over-sized fill is an error, not a partial
    success that could over-settle the order.
    """
    logger.info(f"Updating order {order_id}, filled: {quantity_filled}kWh")
    filled_wh = int(quantity_filled * 1000)
    if filled_wh <= 0:
        raise ValueError("quantity_filled must be a positive whole-Wh amount")

    connection = get_db_connection()
    cursor = connection.cursor()

    try:
        cursor.execute(
            """UPDATE trades
               SET energy = energy - %s,
                   status = CASE WHEN energy = %s THEN 'executed' ELSE status END
               WHERE id = %s
                 AND status = 'pending'
                 AND energy >= %s
               RETURNING id, energy, status""",
            (filled_wh, filled_wh, order_id, filled_wh),
        )
        updated = cursor.fetchone()
        if not updated:
            raise ValueError(
                f"Order {order_id} is not pending with at least {filled_wh} Wh remaining; "
                "refusing a stale, duplicate, or over-sized fill"
            )

        connection.commit()
        return True
    except (Error, ValueError) as e:
        connection.rollback()
        raise RuntimeError(f"Failed to update order {order_id}: {e}") from e
    finally:
        cursor.close()
        connection.close()


@activity.defn
async def lock_funds(user_id: int, amount: int, trade_id: Optional[int] = None) -> int:
    """
    Create an escrow HOLD for a P2P trade and return the hold's payment row ID.

    This is internal bookkeeping only — no money moves through any gateway
    here. The hold is represented honestly: a 'pending' payments row with a
    valid paymentMethod enum value and metadata marking it as an escrow hold.
    ('escrow' is NOT a valid payments.paymentMethod enum value and is never
    used as one.)
    """
    logger.info(f"Locking {amount} cents for user {user_id} (trade {trade_id})")

    connection = get_db_connection()
    cursor = connection.cursor()

    try:
        # Real columns per drizzle/schema.ts: userId, paymentType, paymentMethod.
        # paymentMethod enum: mpesa/airtel_money/tigo_pesa/bank_transfer/card.
        metadata = {
            "escrow": True,
            "escrowStatus": "held",
            "tradeId": trade_id,
            "holdType": "bookkeeping",
            "note": ("Internal P2P escrow hold; no gateway money movement. "
                     "Disbursement to the seller is executed and confirmed "
                     "separately by the payments subsystem."),
        }
        cursor.execute(
            """INSERT INTO payments
               ("userId", "paymentType", amount, currency, "paymentMethod", status, metadata)
               VALUES (%s, 'invoice', %s, 'TZS', 'bank_transfer', 'pending', %s)
               RETURNING id""",
            (user_id, amount, json.dumps(metadata))
        )
        hold_id = cursor.fetchone()[0]
        connection.commit()
        logger.info(f"Escrow hold {hold_id} created for user {user_id}: {amount} cents")
        return hold_id
    except Error as e:
        connection.rollback()
        raise RuntimeError(f"Failed to lock funds for user {user_id}: {e}") from e
    finally:
        cursor.close()
        connection.close()


def _set_escrow_status(hold_id: int, new_status: str) -> None:
    """
    Transition an escrow hold's metadata escrowStatus by row ID.
    Raises if the hold does not exist or is no longer in 'held' state,
    so a double-release or a release of the wrong row fails loudly.
    """
    connection = get_db_connection()
    cursor = connection.cursor()
    try:
        cursor.execute(
            """UPDATE payments
               SET metadata = jsonb_set(
                       jsonb_set(
                           COALESCE(metadata::jsonb, '{}'::jsonb),
                           '{escrowStatus}', to_jsonb(%s::text), true
                       ),
                       '{escrowStatusAt}',
                       to_jsonb(to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), true
                   )::text,
                   "updatedAt" = NOW()
               WHERE id = %s AND status = 'pending'
                 AND metadata::jsonb ->> 'escrowStatus' = 'held'""",
            (new_status, hold_id)
        )
        if cursor.rowcount == 0:
            raise RuntimeError(
                f"Escrow hold {hold_id} not found in 'held' state — refusing to "
                f"mark it '{new_status}' (possible double-settle or wrong row)"
            )
        connection.commit()
    except Error as e:
        connection.rollback()
        raise RuntimeError(f"Failed to update escrow hold {hold_id}: {e}") from e
    finally:
        cursor.close()
        connection.close()


@activity.defn
async def release_funds(hold_id: int) -> bool:
    """
    Release an escrow hold by its payment row ID after verified delivery.

    Bookkeeping only: sets metadata escrowStatus='released' on the hold row.
    It deliberately does NOT mark the payment 'completed' — no money has
    moved. Actual gateway disbursement to the seller is a separate step that
    must be executed and confirmed by the payments subsystem.
    """
    logger.info(f"Releasing escrow hold {hold_id}")
    _set_escrow_status(hold_id, 'released')
    logger.warning(
        f"Escrow hold {hold_id} marked 'released' (bookkeeping only). "
        "Gateway disbursement to the seller must be executed and confirmed "
        "by the payments subsystem as a separate step."
    )
    return True


@activity.defn
async def cancel_escrow_hold(hold_id: int) -> bool:
    """
    Cancel/unlock an escrow hold (e.g. unverified delivery or workflow
    failure). Bookkeeping only: sets metadata escrowStatus='cancelled'.
    """
    logger.info(f"Cancelling escrow hold {hold_id}")
    _set_escrow_status(hold_id, 'cancelled')
    return True


@activity.defn
async def schedule_energy_transfer(seller_id: int, buyer_id: int, quantity: float, delivery_time: str) -> bool:
    """Schedule energy delivery by creating an alert for both parties"""
    logger.info(f"Scheduling {quantity}kWh transfer from {seller_id} to {buyer_id} at {delivery_time}")
    
    connection = get_db_connection()
    cursor = connection.cursor()
    
    try:
        # Real columns per drizzle/schema.ts: userId, alertType, isRead.
        # alertType enum: system/trading/billing/maintenance → 'trading'.
        # severity enum: info/warning/error/critical → 'info'.
        # Create alert for seller
        cursor.execute(
            """INSERT INTO alerts
               ("userId", "alertType", severity, title, message, "isRead", metadata, "createdAt")
               VALUES (%s, 'trading', 'info', 'Energy Transfer Scheduled', %s, false, %s, NOW())""",
            (seller_id,
             f'You have a scheduled energy transfer of {quantity}kWh to buyer at {delivery_time}',
             json.dumps({"type": "energy_transfer", "buyer_id": buyer_id,
                         "quantity": quantity, "delivery_time": delivery_time}))
        )

        # Create alert for buyer
        cursor.execute(
            """INSERT INTO alerts
               ("userId", "alertType", severity, title, message, "isRead", metadata, "createdAt")
               VALUES (%s, 'trading', 'info', 'Energy Transfer Scheduled', %s, false, %s, NOW())""",
            (buyer_id,
             f'You have a scheduled energy delivery of {quantity}kWh from seller at {delivery_time}',
             json.dumps({"type": "energy_transfer", "seller_id": seller_id,
                         "quantity": quantity, "delivery_time": delivery_time}))
        )

        connection.commit()
        return True
    except Error as e:
        connection.rollback()
        raise RuntimeError(f"Failed to schedule energy transfer: {e}") from e
    finally:
        cursor.close()
        connection.close()


@activity.defn
async def monitor_energy_delivery(trade_id: int, duration: int) -> dict:
    """
    Verify actual energy delivery from the seller's telemetry.

    The workflow calls this after the delivery window has ended, so the
    window is [NOW() - duration hours, NOW()]. Delivered energy is estimated
    as AVG(power in W) x duration (h) across the seller's assets — the same
    AVG(power) telemetry pattern used by the DR worker's compliance monitor.

    Returns a dict:
      delivered: True only if delivered energy >= 90% of the traded energy
      reason:    'ok' | 'telemetry_unavailable' | 'insufficient_delivery'
    DB errors raise — they are not 'delivery failed', they are failures.
    """
    logger.info(f"Monitoring delivery for trade {trade_id}, duration: {duration}h")

    connection = get_db_connection()
    cursor = connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    try:
        # Get trade details (trade_id is the seller's p2p_sell row; userId = seller)
        cursor.execute(
            'SELECT "userId", "counterpartyId", energy FROM trades WHERE id = %s',
            (trade_id,)
        )
        trade = cursor.fetchone()

        if not trade:
            raise ValueError(f"Trade {trade_id} not found for delivery monitoring")

        seller_id = trade['userId']
        expected_wh = trade['energy'] or 0

        # Average export power (W) across the seller's assets over the window
        cursor.execute(
            """SELECT AVG(t.power) AS avg_power, COUNT(*) AS samples
               FROM telemetry t
               JOIN assets a ON t."assetId" = a.id
               WHERE a."userId" = %s
                 AND t.timestamp BETWEEN NOW() - make_interval(hours => %s) AND NOW()""",
            (seller_id, duration)
        )
        row = cursor.fetchone()

        if not row or not row['samples'] or row['avg_power'] is None:
            logger.warning(f"No telemetry for seller {seller_id} in delivery window of trade {trade_id}")
            return {
                'delivered': False,
                'reason': 'telemetry_unavailable',
                'delivered_kwh': 0.0,
                'expected_kwh': expected_wh / 1000.0,
            }

        delivered_wh = float(row['avg_power']) * duration
        delivered_kwh = delivered_wh / 1000.0
        expected_kwh = expected_wh / 1000.0
        verified = delivered_wh >= 0.9 * expected_wh

        logger.info(
            f"Trade {trade_id} delivery verification: {delivered_kwh:.2f} kWh delivered "
            f"vs {expected_kwh:.2f} kWh expected ({row['samples']} samples) -> "
            f"{'verified' if verified else 'insufficient'}"
        )
        return {
            'delivered': verified,
            'reason': 'ok' if verified else 'insufficient_delivery',
            'delivered_kwh': delivered_kwh,
            'expected_kwh': expected_kwh,
        }
    except Error as e:
        raise RuntimeError(f"Error monitoring delivery for trade {trade_id}: {e}") from e
    finally:
        cursor.close()
        connection.close()


@activity.defn
async def update_trade_status(trade_id: int, status: str) -> bool:
    """Update trade status in the trades table"""
    logger.info(f"Updating trade {trade_id} status to {status}")
    
    connection = get_db_connection()
    cursor = connection.cursor()
    
    try:
        # Map status to valid enum values
        status_map = {
            'completed': 'executed',
            'failed': 'failed',
            'cancelled': 'cancelled',
            'pending': 'pending',
            'executed': 'executed',
        }
        db_status = status_map.get(status, status)
        
        cursor.execute(
            "UPDATE trades SET status = %s WHERE id = %s",
            (db_status, trade_id)
        )
        
        # Also update any linked trades (buyer/seller counterpart)
        cursor.execute(
            """UPDATE trades SET status = %s
               WHERE metadata::jsonb ->> 'linked_trade_id' = %s""",
            (db_status, str(trade_id))
        )

        connection.commit()
        return True
    except Error as e:
        connection.rollback()
        raise RuntimeError(f"Failed to update trade {trade_id} status: {e}") from e
    finally:
        cursor.close()
        connection.close()


# Workflows
@workflow.defn
class AutomatedTradingWorkflow:
    """Automated trading workflow"""
    
    @workflow.run
    async def run(self, input: AutomatedTradingInput) -> AutomatedTradingResult:
        logger.info(f"Starting automated trading for user {input.user_id}, strategy: {input.strategy}")
        
        result = AutomatedTradingResult(
            success=False,
            trades_executed=0,
            total_volume=0.0,
            total_value=0,
        )
        
        try:
            # Step 1: Get available energy
            available_energy = await workflow.execute_activity(
                get_available_energy,
                args=[input.user_id, input.asset_id],
                start_to_close_timeout=timedelta(seconds=30),
            )
            
            if available_energy == 0:
                # The query SUCCEEDED and found no tradable energy — a
                # legitimate no-op. DB errors raise from the activity and are
                # surfaced via the except branch below, not as 0.0.
                result.success = True
                return result
            
            # Step 2: Find matching orders
            price = input.min_price if input.strategy == 'sell_excess' else input.max_price
            matching_orders = await workflow.execute_activity(
                find_matching_orders,
                args=[input.strategy, price, 10],
                start_to_close_timeout=timedelta(seconds=30),
            )
            
            # Step 3: Execute trades
            for order in matching_orders:
                trade_quantity = min(
                    abs(available_energy),
                    order.get('quantity', 0),
                    input.max_quantity or float('inf')
                )
                
                if trade_quantity == 0:
                    continue
                
                # Create trade
                buyer_id = input.user_id if input.strategy == 'buy_deficit' else order['userId']
                seller_id = input.user_id if input.strategy == 'sell_excess' else order['userId']
                
                trade_id = await workflow.execute_activity(
                    create_trade,
                    args=[buyer_id, seller_id, trade_quantity, order['price']],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                
                if trade_id:
                    result.trades_executed += 1
                    result.total_volume += trade_quantity
                    result.total_value += int(trade_quantity * order['price'])
                    
                    # Update order
                    await workflow.execute_activity(
                        update_order_status,
                        args=[order['id'], trade_quantity],
                        start_to_close_timeout=timedelta(seconds=30),
                    )
                    
                    available_energy += -trade_quantity if input.strategy == 'sell_excess' else trade_quantity
                    
                    if abs(available_energy) < 0.1:
                        break
            
            result.success = True
            logger.info(f"Automated trading completed: {result.trades_executed} trades executed")
            return result
            
        except Exception as e:
            logger.error(f"Automated trading error: {e}")
            result.error = str(e)
            return result


@workflow.defn
class P2PTradingWorkflow:
    """P2P trading workflow with escrow"""
    
    @workflow.run
    async def run(self, input: P2PTradingInput) -> P2PTradingResult:
        logger.info(f"Starting P2P trade: {input.seller_id} -> {input.buyer_id}")
        
        result = P2PTradingResult(success=False)
        trade_id = None
        escrow_hold_id = None

        try:
            # Step 1: Validate seller has energy
            seller_energy = await workflow.execute_activity(
                get_available_energy,
                args=[input.seller_id, 0],
                start_to_close_timeout=timedelta(seconds=30),
            )

            if seller_energy < input.quantity:
                result.error = "Seller does not have enough energy"
                return result

            # Step 2: Create trade
            total_amount = int(input.quantity * input.price_per_kwh)
            trade_id = await workflow.execute_activity(
                create_trade,
                args=[input.buyer_id, input.seller_id, input.quantity, input.price_per_kwh],
                start_to_close_timeout=timedelta(seconds=30),
            )

            if not trade_id:
                result.error = "Failed to create trade"
                return result

            # Step 3: Lock buyer funds in an escrow hold (bookkeeping).
            # Returns the hold's payment row ID; raises on DB failure.
            escrow_hold_id = await workflow.execute_activity(
                lock_funds,
                args=[input.buyer_id, total_amount, trade_id],
                start_to_close_timeout=timedelta(seconds=30),
            )

            if not escrow_hold_id:
                result.error = "Failed to lock funds"
                await workflow.execute_activity(
                    update_trade_status,
                    args=[trade_id, 'failed'],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                return result

            # Step 4: Schedule delivery
            await workflow.execute_activity(
                schedule_energy_transfer,
                args=[input.seller_id, input.buyer_id, input.quantity, input.delivery_time],
                start_to_close_timeout=timedelta(seconds=30),
            )

            # Step 5: Wait (workflow-safe timer) until the end of the delivery
            # window: delivery_time + duration hours.
            try:
                delivery_start = datetime.fromisoformat(input.delivery_time)
            except ValueError as e:
                raise ValueError(f"Invalid delivery_time '{input.delivery_time}': {e}")
            if delivery_start.tzinfo is None:
                delivery_start = delivery_start.replace(tzinfo=timezone.utc)
            delivery_end = delivery_start + timedelta(hours=input.duration)
            wait_seconds = (delivery_end - workflow.now()).total_seconds()
            if wait_seconds > 0:
                logger.info(f"Waiting {wait_seconds:.0f}s until end of delivery window")
                await workflow.sleep(wait_seconds)

            # Step 6: Verify delivery from seller telemetry
            delivery = await workflow.execute_activity(
                monitor_energy_delivery,
                args=[trade_id, input.duration],
                start_to_close_timeout=timedelta(hours=input.duration),
            )

            if not delivery.get('delivered'):
                # Unverified/insufficient delivery: fail the trade, unlock the
                # escrow hold, and return an error result. Funds are NEVER
                # released on unverified delivery.
                reason = delivery.get('reason', 'delivery_not_verified')
                logger.warning(f"P2P trade {trade_id} delivery not verified: {reason}")
                await workflow.execute_activity(
                    update_trade_status,
                    args=[trade_id, 'failed'],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                await workflow.execute_activity(
                    cancel_escrow_hold,
                    args=[escrow_hold_id],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                result.trade_id = trade_id
                result.error = f"Energy delivery not verified: {reason}"
                return result

            # Step 7: Settle (delivery verified)
            await workflow.execute_activity(
                update_trade_status,
                args=[trade_id, 'completed'],
                start_to_close_timeout=timedelta(seconds=30),
            )

            # Step 8: Release the escrow hold by ID (bookkeeping release only;
            # gateway disbursement is confirmed separately by payments subsystem)
            await workflow.execute_activity(
                release_funds,
                args=[escrow_hold_id],
                start_to_close_timeout=timedelta(seconds=30),
            )

            result.success = True
            result.trade_id = trade_id
            result.settlement_amount = total_amount
            logger.info(f"P2P trade completed: {trade_id}")
            return result

        except Exception as e:
            logger.error(f"P2P trading error: {e}")
            result.error = str(e)

            # Compensation: fail the trade and unlock any held escrow.
            if trade_id:
                await workflow.execute_activity(
                    update_trade_status,
                    args=[trade_id, 'failed'],
                    start_to_close_timeout=timedelta(seconds=30),
                )
            if escrow_hold_id:
                await workflow.execute_activity(
                    cancel_escrow_hold,
                    args=[escrow_hold_id],
                    start_to_close_timeout=timedelta(seconds=30),
                )

            return result


async def main():
    """Start the trading worker"""
    # Connect to Temporal
    temporal_address = os.getenv('TEMPORAL_ADDRESS', 'localhost:7233')
    client = await Client.connect(temporal_address)
    
    # Create worker
    worker = Worker(
        client,
        task_queue="trading-execution",
        workflows=[AutomatedTradingWorkflow, P2PTradingWorkflow],
        activities=[
            get_available_energy,
            find_matching_orders,
            create_trade,
            update_order_status,
            lock_funds,
            release_funds,
            cancel_escrow_hold,
            schedule_energy_transfer,
            monitor_energy_delivery,
            update_trade_status,
        ],
    )
    
    logger.info("[Trading Worker] Starting worker on task queue: trading-execution")
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
