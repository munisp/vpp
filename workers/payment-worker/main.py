"""
Temporal Payment Worker

Executes payment processing workflows with retry and compensation logic
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
class PaymentProcessingInput:
    payment_id: int
    user_id: int
    amount: int  # in cents
    gateway: str  # 'mpesa', 'airtel_money', 'tigo_pesa'
    phone_number: str
    account_reference: str
    max_retries: int = 3


@dataclass
class PaymentProcessingResult:
    success: bool
    payment_id: int
    transaction_id: Optional[str] = None
    status: str = 'pending'
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
async def initiate_payment(gateway: str, phone_number: str, amount: int, reference: str) -> dict:
    """Initiate payment through gateway"""
    logger.info(f"Initiating {gateway} payment: {phone_number}, {amount}c, ref: {reference}")
    
    # TODO: Call actual payment gateway API
    # For now, return mock response
    
    return {
        'success': True,
        'transaction_id': f'TXN-{reference}-{os.urandom(4).hex()}',
        'checkout_request_id': f'CHK-{os.urandom(8).hex()}',
        'message': 'Payment initiated successfully',
    }


@activity.defn
async def query_payment_status(gateway: str, transaction_id: str) -> dict:
    """Query payment status from gateway"""
    logger.info(f"Querying payment status: {gateway}, {transaction_id}")
    
    # TODO: Call actual payment gateway API
    # For now, return mock response
    
    return {
        'success': True,
        'status': 'completed',
        'result_code': 0,
        'result_desc': 'Payment successful',
    }


@activity.defn
async def update_payment_status(payment_id: int, status: str, transaction_id: Optional[str] = None, metadata: Optional[dict] = None) -> bool:
    """Update payment status in database"""
    logger.info(f"Updating payment {payment_id} status to {status}")
    
    connection = get_db_connection()
    cursor = connection.cursor()
    
    try:
        if transaction_id:
            cursor.execute(
                "UPDATE payments SET status = %s, transactionId = %s, metadata = %s, updatedAt = NOW() WHERE id = %s",
                (status, transaction_id, str(metadata) if metadata else None, payment_id)
            )
        else:
            cursor.execute(
                "UPDATE payments SET status = %s, updatedAt = NOW() WHERE id = %s",
                (status, payment_id)
            )
        
        connection.commit()
        logger.info(f"Payment {payment_id} updated successfully")
        return True
    except Error as e:
        logger.error(f"Failed to update payment: {e}")
        connection.rollback()
        return False
    finally:
        cursor.close()
        connection.close()


@activity.defn
async def send_payment_notification(user_id: int, payment_id: int, status: str, amount: int) -> bool:
    """Send payment notification to user"""
    logger.info(f"Sending payment notification to user {user_id}: {status}, {amount}c")
    
    # TODO: Send actual notification (email/SMS/push)
    return True


@activity.defn
async def record_payment_audit(payment_id: int, action: str, details: dict) -> bool:
    """Record payment audit log"""
    logger.info(f"Recording audit log for payment {payment_id}: {action}")
    
    connection = get_db_connection()
    cursor = connection.cursor()
    
    try:
        # TODO: Insert into payment_audit_logs table
        return True
    except Error as e:
        logger.error(f"Failed to record audit log: {e}")
        return False
    finally:
        cursor.close()
        connection.close()


@activity.defn
async def process_refund(payment_id: int, reason: str) -> bool:
    """Process payment refund"""
    logger.info(f"Processing refund for payment {payment_id}: {reason}")
    
    # TODO: Call payment gateway refund API
    return True


# Workflows
@workflow.defn
class PaymentProcessingWorkflow:
    """Payment processing workflow with retry and compensation"""
    
    @workflow.run
    async def run(self, input: PaymentProcessingInput) -> PaymentProcessingResult:
        logger.info(f"Starting payment processing for payment {input.payment_id}")
        
        result = PaymentProcessingResult(
            success=False,
            payment_id=input.payment_id,
        )
        
        try:
            # Step 1: Record audit log
            await workflow.execute_activity(
                record_payment_audit,
                args=[input.payment_id, 'payment_initiated', {'gateway': input.gateway}],
                start_to_close_timeout=timedelta(seconds=30),
            )
            
            # Step 2: Initiate payment with retry
            payment_response = None
            for attempt in range(input.max_retries):
                try:
                    payment_response = await workflow.execute_activity(
                        initiate_payment,
                        args=[input.gateway, input.phone_number, input.amount, input.account_reference],
                        start_to_close_timeout=timedelta(seconds=60),
                        retry_policy=workflow.RetryPolicy(
                            initial_interval=timedelta(seconds=5),
                            backoff_coefficient=2.0,
                            maximum_interval=timedelta(seconds=30),
                            maximum_attempts=3,
                        ),
                    )
                    
                    if payment_response['success']:
                        break
                    
                    logger.warning(f"Payment initiation failed, attempt {attempt + 1}/{input.max_retries}")
                    
                    if attempt < input.max_retries - 1:
                        await asyncio.sleep(5 * (attempt + 1))  # Exponential backoff
                        
                except Exception as e:
                    logger.error(f"Payment initiation error: {e}")
                    if attempt == input.max_retries - 1:
                        raise
            
            if not payment_response or not payment_response['success']:
                result.error = "Payment initiation failed after retries"
                result.status = 'failed'
                
                await workflow.execute_activity(
                    update_payment_status,
                    args=[input.payment_id, 'failed', None, {'error': result.error}],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                
                return result
            
            transaction_id = payment_response['transaction_id']
            result.transaction_id = transaction_id
            
            # Step 3: Update payment with transaction ID
            await workflow.execute_activity(
                update_payment_status,
                args=[input.payment_id, 'pending', transaction_id, payment_response],
                start_to_close_timeout=timedelta(seconds=30),
            )
            
            # Step 4: Poll for payment completion (with timeout)
            max_poll_duration = timedelta(minutes=5)
            poll_interval = timedelta(seconds=10)
            start_time = workflow.now()
            
            while workflow.now() - start_time < max_poll_duration:
                # Query payment status
                status_response = await workflow.execute_activity(
                    query_payment_status,
                    args=[input.gateway, transaction_id],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                
                if status_response['status'] == 'completed':
                    # Payment successful
                    result.success = True
                    result.status = 'completed'
                    
                    await workflow.execute_activity(
                        update_payment_status,
                        args=[input.payment_id, 'completed', transaction_id, status_response],
                        start_to_close_timeout=timedelta(seconds=30),
                    )
                    
                    await workflow.execute_activity(
                        send_payment_notification,
                        args=[input.user_id, input.payment_id, 'completed', input.amount],
                        start_to_close_timeout=timedelta(seconds=30),
                    )
                    
                    await workflow.execute_activity(
                        record_payment_audit,
                        args=[input.payment_id, 'payment_completed', status_response],
                        start_to_close_timeout=timedelta(seconds=30),
                    )
                    
                    logger.info(f"Payment {input.payment_id} completed successfully")
                    return result
                    
                elif status_response['status'] == 'failed':
                    # Payment failed
                    result.status = 'failed'
                    result.error = status_response.get('result_desc', 'Payment failed')
                    
                    await workflow.execute_activity(
                        update_payment_status,
                        args=[input.payment_id, 'failed', transaction_id, status_response],
                        start_to_close_timeout=timedelta(seconds=30),
                    )
                    
                    await workflow.execute_activity(
                        send_payment_notification,
                        args=[input.user_id, input.payment_id, 'failed', input.amount],
                        start_to_close_timeout=timedelta(seconds=30),
                    )
                    
                    logger.warning(f"Payment {input.payment_id} failed: {result.error}")
                    return result
                
                # Still pending, wait and retry
                await asyncio.sleep(poll_interval.total_seconds())
            
            # Timeout reached
            result.status = 'pending'
            result.error = "Payment verification timeout"
            
            logger.warning(f"Payment {input.payment_id} verification timeout")
            return result
            
        except Exception as e:
            logger.error(f"Payment processing error: {e}")
            result.error = str(e)
            result.status = 'failed'
            
            # Compensation: mark as failed and notify
            await workflow.execute_activity(
                update_payment_status,
                args=[input.payment_id, 'failed', None, {'error': str(e)}],
                start_to_close_timeout=timedelta(seconds=30),
            )
            
            await workflow.execute_activity(
                send_payment_notification,
                args=[input.user_id, input.payment_id, 'failed', input.amount],
                start_to_close_timeout=timedelta(seconds=30),
            )
            
            return result


async def main():
    """Start the payment worker"""
    # Connect to Temporal
    temporal_address = os.getenv('TEMPORAL_ADDRESS', 'localhost:7233')
    client = await Client.connect(temporal_address)
    
    # Create worker
    worker = Worker(
        client,
        task_queue="payment-processing",
        workflows=[PaymentProcessingWorkflow],
        activities=[
            initiate_payment,
            query_payment_status,
            update_payment_status,
            send_payment_notification,
            record_payment_audit,
            process_refund,
        ],
    )
    
    logger.info("[Payment Worker] Starting worker on task queue: payment-processing")
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
