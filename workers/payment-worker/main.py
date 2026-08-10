"""
Temporal Payment Worker

Executes payment processing workflows with retry and compensation logic.
Calls real payment gateway APIs (M-Pesa, Airtel Money, Tigo Pesa) via HTTP.
"""

import asyncio
import os
import json
import logging
import secrets
from datetime import timedelta
from typing import Optional
from dataclasses import dataclass

import httpx
import mysql.connector
from mysql.connector import Error
from temporalio import activity, workflow
from temporalio.client import Client
from temporalio.worker import Worker

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Gateway configuration (read from environment)
# ---------------------------------------------------------------------------
MPESA_BASE_URL      = os.getenv('MPESA_BASE_URL', 'https://sandbox.safaricom.co.ke')
MPESA_CONSUMER_KEY  = os.getenv('MPESA_CONSUMER_KEY', '')
MPESA_CONSUMER_SECRET = os.getenv('MPESA_CONSUMER_SECRET', '')
MPESA_SHORTCODE     = os.getenv('MPESA_SHORTCODE', '')
MPESA_PASSKEY       = os.getenv('MPESA_PASSKEY', '')
MPESA_CALLBACK_URL  = os.getenv('MPESA_CALLBACK_URL', '')

AIRTEL_BASE_URL     = os.getenv('AIRTEL_BASE_URL', 'https://openapi.airtel.africa')
AIRTEL_CLIENT_ID    = os.getenv('AIRTEL_CLIENT_ID', '')
AIRTEL_CLIENT_SECRET = os.getenv('AIRTEL_CLIENT_SECRET', '')

TIGO_BASE_URL       = os.getenv('TIGO_BASE_URL', 'https://api.tigopesa.com')
TIGO_API_KEY        = os.getenv('TIGO_API_KEY', '')
TIGO_API_SECRET     = os.getenv('TIGO_API_SECRET', '')
TIGO_MERCHANT       = os.getenv('TIGO_MERCHANT_NUMBER', '')


# ---------------------------------------------------------------------------
# Workflow Input / Output Types
# ---------------------------------------------------------------------------
@dataclass
class PaymentProcessingInput:
    payment_id: int
    user_id: int
    amount: int          # in cents
    gateway: str         # 'mpesa', 'airtel_money', 'tigo_pesa'
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


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------
def get_db_connection():
    """Create a MySQL database connection from environment variables."""
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


# ---------------------------------------------------------------------------
# Gateway helpers
# ---------------------------------------------------------------------------
async def _mpesa_access_token() -> str:
    """Fetch a fresh M-Pesa OAuth2 access token."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials",
            auth=(MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET),
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()['access_token']


async def _airtel_access_token() -> str:
    """Fetch a fresh Airtel Money OAuth2 access token."""
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{AIRTEL_BASE_URL}/auth/oauth2/token",
            json={
                "client_id": AIRTEL_CLIENT_ID,
                "client_secret": AIRTEL_CLIENT_SECRET,
                "grant_type": "client_credentials",
            },
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()['access_token']


# ---------------------------------------------------------------------------
# Activities
# ---------------------------------------------------------------------------
@activity.defn
async def initiate_payment(gateway: str, phone_number: str, amount: int, reference: str) -> dict:
    """Initiate a payment through the appropriate mobile-money gateway API."""
    logger.info(f"Initiating {gateway} payment: {phone_number}, {amount}c, ref: {reference}")

    amount_main_unit = amount / 100  # convert cents → currency unit

    if gateway == 'mpesa':
        if not MPESA_CONSUMER_KEY:
            raise RuntimeError("MPESA_CONSUMER_KEY is not configured")
        import base64, datetime
        token = await _mpesa_access_token()
        timestamp = datetime.datetime.now().strftime('%Y%m%d%H%M%S')
        password = base64.b64encode(
            f"{MPESA_SHORTCODE}{MPESA_PASSKEY}{timestamp}".encode()
        ).decode()
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "BusinessShortCode": MPESA_SHORTCODE,
                    "Password": password,
                    "Timestamp": timestamp,
                    "TransactionType": "CustomerPayBillOnline",
                    "Amount": int(amount_main_unit),
                    "PartyA": phone_number,
                    "PartyB": MPESA_SHORTCODE,
                    "PhoneNumber": phone_number,
                    "CallBackURL": MPESA_CALLBACK_URL,
                    "AccountReference": reference,
                    "TransactionDesc": f"VPP payment {reference}",
                },
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            return {
                'success': data.get('ResponseCode') == '0',
                'transaction_id': data.get('CheckoutRequestID'),
                'checkout_request_id': data.get('CheckoutRequestID'),
                'message': data.get('CustomerMessage', data.get('ResponseDescription', '')),
            }

    elif gateway == 'airtel_money':
        if not AIRTEL_CLIENT_ID:
            raise RuntimeError("AIRTEL_CLIENT_ID is not configured")
        token = await _airtel_access_token()
        txn_id = f"VPP-{reference}-{secrets.token_hex(4).upper()}"
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{AIRTEL_BASE_URL}/merchant/v1/payments/",
                headers={"Authorization": f"Bearer {token}", "X-Country": "TZ", "X-Currency": "TZS"},
                json={
                    "reference": txn_id,
                    "subscriber": {"country": "TZ", "currency": "TZS", "msisdn": phone_number},
                    "transaction": {"amount": amount_main_unit, "country": "TZ", "currency": "TZS", "id": txn_id},
                },
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            status = data.get('data', {}).get('transaction', {}).get('status', '')
            return {
                'success': status in ('TS', 'SUCCESS'),
                'transaction_id': txn_id,
                'checkout_request_id': txn_id,
                'message': data.get('status', {}).get('message', ''),
            }

    elif gateway == 'tigo_pesa':
        if not TIGO_API_KEY:
            raise RuntimeError("TIGO_API_KEY is not configured")
        txn_id = f"VPP-{reference}-{secrets.token_hex(4).upper()}"
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{TIGO_BASE_URL}/v1/tigo/payment-auth/authorize",
                headers={"Authorization": f"Bearer {TIGO_API_KEY}"},
                json={
                    "MasterMerchant": {"Account": TIGO_MERCHANT, "Pin": TIGO_API_SECRET},
                    "Subscriber": {"Account": phone_number, "CountryCode": "255", "Country": "TZA"},
                    "Order": {"ID": txn_id, "Amount": str(amount_main_unit), "Currency": "TZS"},
                    "redirectUri": "",
                    "Language": "EN",
                    "OriginPayment": {"Amount": str(amount_main_unit), "CurrencyCode": "TZS", "Country": "TZA"},
                },
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            return {
                'success': data.get('ResponseCode') == 'BILLER_SYSTEM_00',
                'transaction_id': txn_id,
                'checkout_request_id': txn_id,
                'message': data.get('ResponseDescription', ''),
            }

    else:
        raise ValueError(f"Unsupported payment gateway: {gateway}")


@activity.defn
async def query_payment_status(gateway: str, transaction_id: str) -> dict:
    """Query the real payment status from the gateway API."""
    logger.info(f"Querying payment status: {gateway}, {transaction_id}")

    if gateway == 'mpesa':
        if not MPESA_CONSUMER_KEY:
            raise RuntimeError("MPESA_CONSUMER_KEY is not configured")
        import base64, datetime
        token = await _mpesa_access_token()
        timestamp = datetime.datetime.now().strftime('%Y%m%d%H%M%S')
        password = base64.b64encode(
            f"{MPESA_SHORTCODE}{MPESA_PASSKEY}{timestamp}".encode()
        ).decode()
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{MPESA_BASE_URL}/mpesa/stkpushquery/v1/query",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "BusinessShortCode": MPESA_SHORTCODE,
                    "Password": password,
                    "Timestamp": timestamp,
                    "CheckoutRequestID": transaction_id,
                },
                timeout=15,
            )
            resp.raise_for_status()
            data = resp.json()
            result_code = data.get('ResultCode', '-1')
            return {
                'success': result_code == '0',
                'status': 'completed' if result_code == '0' else ('pending' if result_code == '1032' else 'failed'),
                'result_code': result_code,
                'result_desc': data.get('ResultDesc', ''),
            }

    elif gateway == 'airtel_money':
        if not AIRTEL_CLIENT_ID:
            raise RuntimeError("AIRTEL_CLIENT_ID is not configured")
        token = await _airtel_access_token()
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{AIRTEL_BASE_URL}/standard/v1/payments/{transaction_id}",
                headers={"Authorization": f"Bearer {token}", "X-Country": "TZ", "X-Currency": "TZS"},
                timeout=15,
            )
            resp.raise_for_status()
            data = resp.json()
            status_code = data.get('data', {}).get('transaction', {}).get('status', '')
            return {
                'success': status_code in ('TS', 'SUCCESS'),
                'status': 'completed' if status_code in ('TS', 'SUCCESS') else ('pending' if status_code == 'TIP' else 'failed'),
                'result_code': status_code,
                'result_desc': data.get('status', {}).get('message', ''),
            }

    elif gateway == 'tigo_pesa':
        # Tigo Pesa uses callback-based confirmation; status is set by the webhook.
        # Return 'pending' so the workflow polls until the webhook updates the DB.
        return {'success': False, 'status': 'pending', 'result_code': 'PENDING', 'result_desc': 'Awaiting callback'}

    else:
        raise ValueError(f"Unsupported payment gateway: {gateway}")


@activity.defn
async def update_payment_status(
    payment_id: int,
    status: str,
    transaction_id: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> bool:
    """Update payment status in the database."""
    logger.info(f"Updating payment {payment_id} status to {status}")
    connection = get_db_connection()
    cursor = connection.cursor()
    try:
        if transaction_id:
            cursor.execute(
                "UPDATE payments SET status = %s, transactionId = %s, metadata = %s, updatedAt = NOW() WHERE id = %s",
                (status, transaction_id, json.dumps(metadata) if metadata else None, payment_id),
            )
        else:
            cursor.execute(
                "UPDATE payments SET status = %s, updatedAt = NOW() WHERE id = %s",
                (status, payment_id),
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
    """
    Insert a push notification record into the database.
    The Node.js notification service polls this table and delivers to FCM/APNS.
    """
    logger.info(f"Sending payment notification to user {user_id}: {status}, {amount}c")
    connection = get_db_connection()
    cursor = connection.cursor()
    try:
        title = "Payment Successful" if status == 'completed' else "Payment Failed"
        body = (
            f"Your payment of {amount / 100:.2f} was received."
            if status == 'completed'
            else f"Your payment of {amount / 100:.2f} could not be completed."
        )
        cursor.execute(
            """INSERT INTO notifications (userId, title, body, type, data, createdAt)
               VALUES (%s, %s, %s, 'payment', %s, NOW())""",
            (user_id, title, body, json.dumps({'paymentId': payment_id, 'status': status})),
        )
        connection.commit()
        logger.info(f"Notification queued for user {user_id}")
        return True
    except Error as e:
        logger.error(f"Failed to queue notification: {e}")
        connection.rollback()
        return False
    finally:
        cursor.close()
        connection.close()


@activity.defn
async def record_payment_audit(payment_id: int, action: str, details: dict) -> bool:
    """Insert an audit log entry for the payment action."""
    logger.info(f"Recording audit log for payment {payment_id}: {action}")
    connection = get_db_connection()
    cursor = connection.cursor()
    try:
        cursor.execute(
            """INSERT INTO payment_audit_logs (paymentId, action, details, createdAt)
               VALUES (%s, %s, %s, NOW())""",
            (payment_id, action, json.dumps(details)),
        )
        connection.commit()
        return True
    except Error as e:
        logger.error(f"Failed to record audit log: {e}")
        connection.rollback()
        return False
    finally:
        cursor.close()
        connection.close()


@activity.defn
async def process_refund(payment_id: int, reason: str) -> bool:
    """
    Initiate a refund via the payment gateway.
    Reads the payment record to determine gateway and transaction ID.
    """
    logger.info(f"Processing refund for payment {payment_id}: {reason}")
    connection = get_db_connection()
    cursor = connection.cursor(dictionary=True)
    try:
        cursor.execute(
            "SELECT gateway, transactionId, amount, phoneNumber FROM payments WHERE id = %s",
            (payment_id,),
        )
        payment = cursor.fetchone()
        if not payment:
            logger.error(f"Payment {payment_id} not found for refund")
            return False

        gateway = payment.get('gateway') or payment.get('paymentMethod', '')
        transaction_id = payment.get('transactionId', '')
        amount = payment.get('amount', 0)
        phone = payment.get('phoneNumber', '')

        if gateway == 'mpesa':
            if not MPESA_CONSUMER_KEY:
                raise RuntimeError("MPESA_CONSUMER_KEY is not configured for refund")
            token = await _mpesa_access_token()
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{MPESA_BASE_URL}/mpesa/reversal/v1/request",
                    headers={"Authorization": f"Bearer {token}"},
                    json={
                        "Initiator": os.getenv('MPESA_INITIATOR', ''),
                        "SecurityCredential": os.getenv('MPESA_SECURITY_CREDENTIAL', ''),
                        "CommandID": "TransactionReversal",
                        "TransactionID": transaction_id,
                        "Amount": int(amount / 100),
                        "ReceiverParty": MPESA_SHORTCODE,
                        "RecieverIdentifierType": "11",
                        "ResultURL": MPESA_CALLBACK_URL,
                        "QueueTimeOutURL": MPESA_CALLBACK_URL,
                        "Remarks": reason,
                        "Occasion": f"Refund for payment {payment_id}",
                    },
                    timeout=30,
                )
                resp.raise_for_status()
                data = resp.json()
                success = data.get('ResponseCode') == '0'
        else:
            # Airtel and Tigo refunds require manual processing via their portals;
            # log the request and mark for manual review.
            logger.warning(
                f"Automated refund not supported for gateway '{gateway}'. "
                f"Payment {payment_id} (txn: {transaction_id}) requires manual refund."
            )
            cursor.execute(
                "UPDATE payments SET status = 'refund_pending', updatedAt = NOW() WHERE id = %s",
                (payment_id,),
            )
            connection.commit()
            return True

        if success:
            cursor.execute(
                "UPDATE payments SET status = 'refunded', updatedAt = NOW() WHERE id = %s",
                (payment_id,),
            )
            connection.commit()
            logger.info(f"Refund initiated for payment {payment_id}")
        return success

    except Exception as e:
        logger.error(f"Refund failed for payment {payment_id}: {e}")
        return False
    finally:
        cursor.close()
        connection.close()


# ---------------------------------------------------------------------------
# Workflow
# ---------------------------------------------------------------------------
@workflow.defn
class PaymentProcessingWorkflow:
    """Payment processing workflow with retry and compensation."""

    @workflow.run
    async def run(self, input: PaymentProcessingInput) -> PaymentProcessingResult:
        logger.info(f"Starting payment processing for payment {input.payment_id}")

        result = PaymentProcessingResult(
            success=False,
            payment_id=input.payment_id,
        )

        try:
            # Step 1: Initiate payment with gateway
            payment_response = await workflow.execute_activity(
                initiate_payment,
                args=[input.gateway, input.phone_number, input.amount, input.account_reference],
                start_to_close_timeout=timedelta(seconds=60),
            )

            if not payment_response.get('success'):
                result.error = payment_response.get('message', 'Payment initiation failed')
                result.status = 'failed'
                await workflow.execute_activity(
                    update_payment_status,
                    args=[input.payment_id, 'failed', None, payment_response],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                return result

            transaction_id = payment_response['transaction_id']
            result.transaction_id = transaction_id

            # Step 2: Update payment with transaction ID
            await workflow.execute_activity(
                update_payment_status,
                args=[input.payment_id, 'pending', transaction_id, payment_response],
                start_to_close_timeout=timedelta(seconds=30),
            )

            # Step 3: Poll for payment completion (with timeout)
            max_poll_duration = timedelta(minutes=5)
            poll_interval = timedelta(seconds=10)
            start_time = workflow.now()

            while workflow.now() - start_time < max_poll_duration:
                status_response = await workflow.execute_activity(
                    query_payment_status,
                    args=[input.gateway, transaction_id],
                    start_to_close_timeout=timedelta(seconds=30),
                )

                if status_response['status'] == 'completed':
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

                # Still pending — wait before next poll
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


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
async def main():
    """Start the payment worker."""
    temporal_address = os.getenv('TEMPORAL_ADDRESS', 'localhost:7233')
    client = await Client.connect(temporal_address)

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
