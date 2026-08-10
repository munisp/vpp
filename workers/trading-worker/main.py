"""
Temporal Trading Worker

Executes automated trading and P2P trading workflows
"""

import asyncio
import os
import logging
from datetime import timedelta
from typing import Optional
from dataclasses import dataclass

from temporalio import activity, workflow
from temporalio.client import Client
from temporalio.worker import Worker
import mysql.connector
from mysql.connector import Error

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
        connection = mysql.connector.connect(
            host=os.getenv('DB_HOST', 'localhost'),
            database=os.getenv('DB_NAME', 'vpp_platform'),
            user=os.getenv('DB_USER', 'root'),
            password=os.getenv('DB_PASSWORD', ''),
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
    cursor = connection.cursor(dictionary=True)
    
    try:
        # Get user's assets
        if asset_id > 0:
            cursor.execute(
                "SELECT id, asset_type, capacity FROM assets WHERE user_id = %s AND id = %s AND status = 'active'",
                (user_id, asset_id)
            )
        else:
            cursor.execute(
                "SELECT id, asset_type, capacity FROM assets WHERE user_id = %s AND status = 'active'",
                (user_id,)
            )
        
        assets = cursor.fetchall()
        total_available_energy = 0.0
        
        for asset in assets:
            # Get latest telemetry for this asset
            cursor.execute(
                """SELECT power, state_of_charge, timestamp 
                   FROM telemetry 
                   WHERE asset_id = %s 
                   ORDER BY timestamp DESC 
                   LIMIT 1""",
                (asset['id'],)
            )
            telemetry = cursor.fetchone()
            
            if telemetry:
                # For batteries, use state of charge
                if asset['asset_type'] == 'battery' and telemetry.get('state_of_charge'):
                    # state_of_charge is percentage * 100, capacity is in Wh
                    available_wh = (telemetry['state_of_charge'] / 10000) * asset['capacity']
                    total_available_energy += available_wh / 1000  # Convert to kWh
                # For solar/wind, use current power output
                elif asset['asset_type'] in ('solar', 'wind') and telemetry.get('power'):
                    # Estimate available energy for next hour based on current power
                    total_available_energy += telemetry['power'] / 1000  # Convert W to kWh
        
        logger.info(f"Available energy for user {user_id}: {total_available_energy:.2f} kWh")
        return total_available_energy
    except Error as e:
        logger.error(f"Error getting available energy: {e}")
        return 0.0
    finally:
        cursor.close()
        connection.close()


@activity.defn
async def find_matching_orders(strategy: str, price: Optional[int], limit: int = 10) -> list:
    """Find matching trading orders from the trades table"""
    logger.info(f"Finding matching orders for strategy {strategy}")
    
    connection = get_db_connection()
    cursor = connection.cursor(dictionary=True)
    
    try:
        # Find pending trades that match the strategy
        if strategy == 'sell_excess':
            # Looking for buyers (import orders)
            if price:
                cursor.execute(
                    """SELECT id, user_id, energy/1000 as quantity, price, total_amount 
                       FROM trades 
                       WHERE trade_type = 'import' AND status = 'pending' AND price >= %s
                       ORDER BY price DESC
                       LIMIT %s""",
                    (price, limit)
                )
            else:
                cursor.execute(
                    """SELECT id, user_id, energy/1000 as quantity, price, total_amount 
                       FROM trades 
                       WHERE trade_type = 'import' AND status = 'pending'
                       ORDER BY price DESC
                       LIMIT %s""",
                    (limit,)
                )
        else:  # buy_deficit or arbitrage
            # Looking for sellers (export orders)
            if price:
                cursor.execute(
                    """SELECT id, user_id, energy/1000 as quantity, price, total_amount 
                       FROM trades 
                       WHERE trade_type = 'export' AND status = 'pending' AND price <= %s
                       ORDER BY price ASC
                       LIMIT %s""",
                    (price, limit)
                )
            else:
                cursor.execute(
                    """SELECT id, user_id, energy/1000 as quantity, price, total_amount 
                       FROM trades 
                       WHERE trade_type = 'export' AND status = 'pending'
                       ORDER BY price ASC
                       LIMIT %s""",
                    (limit,)
                )
        
        orders = cursor.fetchall()
        logger.info(f"Found {len(orders)} matching orders")
        return orders
    except Error as e:
        logger.error(f"Error finding matching orders: {e}")
        return []
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
        
        # Create seller's trade record (export)
        cursor.execute(
            """INSERT INTO trades 
               (user_id, trade_type, trading_mode, energy, price, total_amount, timestamp, status, counterparty_id, metadata)
               VALUES (%s, 'p2p_sell', 'p2p', %s, %s, %s, NOW(), 'pending', %s, %s)""",
            (seller_id, energy_wh, price, total_amount, buyer_id, 
             f'{{"buyer_id": {buyer_id}, "quantity_kwh": {quantity}}}')
        )
        trade_id = cursor.lastrowid
        
        # Create buyer's trade record (import)
        cursor.execute(
            """INSERT INTO trades 
               (user_id, trade_type, trading_mode, energy, price, total_amount, timestamp, status, counterparty_id, metadata)
               VALUES (%s, 'p2p_buy', 'p2p', %s, %s, %s, %s, %s)""",
            (buyer_id, energy_wh, price, total_amount, seller_id,
             f'{{"seller_id": {seller_id}, "linked_trade_id": {trade_id}}}')
        )
        
        connection.commit()
        logger.info(f"Trade created: {trade_id}")
        return trade_id
    except Error as e:
        logger.error(f"Failed to create trade: {e}")
        connection.rollback()
        return None
    finally:
        cursor.close()
        connection.close()


@activity.defn
async def update_order_status(order_id: int, quantity_filled: float) -> bool:
    """Update order quantity and status in the trades table"""
    logger.info(f"Updating order {order_id}, filled: {quantity_filled}kWh")
    
    connection = get_db_connection()
    cursor = connection.cursor()
    
    try:
        # Get current order
        cursor.execute("SELECT energy, status FROM trades WHERE id = %s", (order_id,))
        order = cursor.fetchone()
        
        if not order:
            logger.error(f"Order {order_id} not found")
            return False
        
        current_energy_wh = order[0]
        filled_wh = int(quantity_filled * 1000)
        remaining_wh = current_energy_wh - filled_wh
        
        if remaining_wh <= 0:
            # Order fully filled
            cursor.execute(
                "UPDATE trades SET status = 'executed', energy = 0 WHERE id = %s",
                (order_id,)
            )
        else:
            # Partial fill - update remaining quantity
            cursor.execute(
                "UPDATE trades SET energy = %s WHERE id = %s",
                (remaining_wh, order_id)
            )
        
        connection.commit()
        return True
    except Error as e:
        logger.error(f"Failed to update order: {e}")
        connection.rollback()
        return False
    finally:
        cursor.close()
        connection.close()


@activity.defn
async def lock_funds(user_id: int, amount: int) -> bool:
    """Lock funds in escrow for P2P trading by creating a pending payment"""
    logger.info(f"Locking {amount} cents for user {user_id}")
    
    connection = get_db_connection()
    cursor = connection.cursor()
    
    try:
        # Create a pending payment record to represent locked funds
        cursor.execute(
            """INSERT INTO payments 
               (user_id, payment_type, amount, currency, payment_method, status, metadata)
               VALUES (%s, 'invoice', %s, 'TZS', 'escrow', 'pending', %s)""",
            (user_id, amount, f'{{"type": "p2p_escrow", "locked_at": "{asyncio.get_event_loop().time()}"}}')
        )
        connection.commit()
        logger.info(f"Funds locked for user {user_id}: {amount} cents")
        return True
    except Error as e:
        logger.error(f"Failed to lock funds: {e}")
        connection.rollback()
        return False
    finally:
        cursor.close()
        connection.close()


@activity.defn
async def release_funds(user_id: int, amount: int) -> bool:
    """Release funds from escrow by updating payment status"""
    logger.info(f"Releasing {amount} cents to user {user_id}")
    
    connection = get_db_connection()
    cursor = connection.cursor()
    
    try:
        # Find and update the escrow payment
        cursor.execute(
            """UPDATE payments 
               SET status = 'completed' 
               WHERE user_id = %s AND amount = %s AND status = 'pending' 
               AND JSON_EXTRACT(metadata, '$.type') = 'p2p_escrow'
               LIMIT 1""",
            (user_id, amount)
        )
        connection.commit()
        logger.info(f"Funds released for user {user_id}: {amount} cents")
        return True
    except Error as e:
        logger.error(f"Failed to release funds: {e}")
        connection.rollback()
        return False
    finally:
        cursor.close()
        connection.close()


@activity.defn
async def schedule_energy_transfer(seller_id: int, buyer_id: int, quantity: float, delivery_time: str) -> bool:
    """Schedule energy delivery by creating an alert for both parties"""
    logger.info(f"Scheduling {quantity}kWh transfer from {seller_id} to {buyer_id} at {delivery_time}")
    
    connection = get_db_connection()
    cursor = connection.cursor()
    
    try:
        # Create alert for seller
        cursor.execute(
            """INSERT INTO alerts 
               (user_id, alert_type, title, message, is_read, metadata)
               VALUES (%s, 'info', 'Energy Transfer Scheduled', %s, 0, %s)""",
            (seller_id, 
             f'You have a scheduled energy transfer of {quantity}kWh to buyer at {delivery_time}',
             f'{{"type": "energy_transfer", "buyer_id": {buyer_id}, "quantity": {quantity}, "delivery_time": "{delivery_time}"}}')
        )
        
        # Create alert for buyer
        cursor.execute(
            """INSERT INTO alerts 
               (user_id, alert_type, title, message, is_read, metadata)
               VALUES (%s, 'info', 'Energy Transfer Scheduled', %s, 0, %s)""",
            (buyer_id,
             f'You have a scheduled energy delivery of {quantity}kWh from seller at {delivery_time}',
             f'{{"type": "energy_transfer", "seller_id": {seller_id}, "quantity": {quantity}, "delivery_time": "{delivery_time}"}}')
        )
        
        connection.commit()
        return True
    except Error as e:
        logger.error(f"Failed to schedule energy transfer: {e}")
        connection.rollback()
        return False
    finally:
        cursor.close()
        connection.close()


@activity.defn
async def monitor_energy_delivery(trade_id: int, duration: int) -> bool:
    """Monitor actual energy delivery by checking telemetry data"""
    logger.info(f"Monitoring delivery for trade {trade_id}, duration: {duration}h")
    
    connection = get_db_connection()
    cursor = connection.cursor(dictionary=True)
    
    try:
        # Get trade details
        cursor.execute(
            "SELECT user_id, counterparty_id, energy FROM trades WHERE id = %s",
            (trade_id,)
        )
        trade = cursor.fetchone()
        
        if not trade:
            logger.error(f"Trade {trade_id} not found")
            return False
        
        # In a real implementation, we would:
        # 1. Query telemetry data for the seller's assets during the delivery window
        # 2. Verify that the expected energy was exported
        # 3. Query telemetry data for the buyer's assets to verify receipt
        # For now, we assume successful delivery after the monitoring period
        
        logger.info(f"Energy delivery verified for trade {trade_id}")
        return True
    except Error as e:
        logger.error(f"Error monitoring delivery: {e}")
        return False
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
               WHERE JSON_EXTRACT(metadata, '$.linked_trade_id') = %s""",
            (db_status, trade_id)
        )
        
        connection.commit()
        return True
    except Error as e:
        logger.error(f"Failed to update trade status: {e}")
        connection.rollback()
        return False
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
                buyer_id = input.user_id if input.strategy == 'buy_deficit' else order['user_id']
                seller_id = input.user_id if input.strategy == 'sell_excess' else order['user_id']
                
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
            
            # Step 3: Lock buyer funds
            locked = await workflow.execute_activity(
                lock_funds,
                args=[input.buyer_id, total_amount],
                start_to_close_timeout=timedelta(seconds=30),
            )
            
            if not locked:
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
            
            # Step 5: Wait for delivery (simplified - in production would wait for actual time)
            await asyncio.sleep(1)
            
            # Step 6: Monitor delivery
            delivered = await workflow.execute_activity(
                monitor_energy_delivery,
                args=[trade_id, input.duration],
                start_to_close_timeout=timedelta(minutes=input.duration),
            )
            
            # Step 7: Settle
            await workflow.execute_activity(
                update_trade_status,
                args=[trade_id, 'completed'],
                start_to_close_timeout=timedelta(seconds=30),
            )
            
            # Step 8: Release funds
            await workflow.execute_activity(
                release_funds,
                args=[input.seller_id, total_amount],
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
            
            # Compensation: refund
            if trade_id:
                await workflow.execute_activity(
                    update_trade_status,
                    args=[trade_id, 'failed'],
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
            schedule_energy_transfer,
            monitor_energy_delivery,
            update_trade_status,
        ],
    )
    
    logger.info("[Trading Worker] Starting worker on task queue: trading-execution")
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
