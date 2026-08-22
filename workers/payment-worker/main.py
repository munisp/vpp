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
import psycopg2
import psycopg2.extras
from psycopg2 import Error
from temporalio import activity, workflow
from temporalio.client import Client
from temporalio.worker import Worker

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Gateway configuration (read from environment)
# ---------------------------------------------------------------------------
# No default: the base URL selects sandbox vs production and MUST be set
# explicitly via the environment. Worker startup refuses to run without it.
MPESA_BASE_URL      = os.getenv('MPESA_BASE_URL', '')
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
    """Create a PostgreSQL database connection from environment variables."""
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
        # Tigo Pesa confirms payments via a server-to-server callback; the
        # webhook handler writes the final status into the payments table.
        # The real inquiry is therefore a DB read of the callback-recorded
        # status for the payment carrying this transaction ID.
        connection = get_db_connection()
        cursor = connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        try:
            cursor.execute(
                'SELECT id, status FROM payments WHERE "transactionId" = %s ORDER BY id DESC LIMIT 1',
                (transaction_id,),
            )
            row = cursor.fetchone()
        finally:
            cursor.close()
            connection.close()
        if not row:
            raise RuntimeError(
                f"Status inquiry failed: no payment row with transactionId '{transaction_id}'"
            )
        db_status = row['status']
        return {
            'success': db_status == 'completed',
            'status': db_status if db_status in ('completed', 'failed') else 'pending',
            'result_code': db_status.upper(),
            'result_desc': 'Status recorded by Tigo Pesa payment callback',
            'payment_id': row['id'],
        }

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
                'UPDATE payments SET status = %s, "transactionId" = %s, metadata = %s, "updatedAt" = NOW() WHERE id = %s',
                (status, transaction_id, json.dumps(metadata) if metadata else None, payment_id),
            )
        else:
            cursor.execute(
                'UPDATE payments SET status = %s, "updatedAt" = NOW() WHERE id = %s',
                (status, payment_id),
            )
        connection.commit()
        logger.info(f"Payment {payment_id} updated successfully")
        return True
    except Error as e:
        connection.rollback()
        raise RuntimeError(f"Failed to update payment {payment_id}: {e}") from e
    finally:
        cursor.close()
        connection.close()


@activity.defn
async def send_payment_notification(user_id: int, payment_id: int, status: str, amount: int) -> bool:
    """
    Insert a user-facing alert row into the real `alerts` table.
    The notification service polls `alerts` and delivers via FCM/APNS/email.
    Raises on database failure so Temporal retries instead of silently
    dropping the notification.
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
        # alerts.alertType enum: system/trading/billing/maintenance
        severity = 'info' if status == 'completed' else 'error'
        cursor.execute(
            """INSERT INTO alerts ("userId", "alertType", severity, title, message, "isRead", metadata, "createdAt")
               VALUES (%s, 'billing', %s, %s, %s, false, %s, NOW())""",
            (user_id, severity, title, body, json.dumps({'paymentId': payment_id, 'status': status})),
        )
        connection.commit()
        logger.info(f"Notification queued for user {user_id}")
        return True
    except Error as e:
        connection.rollback()
        raise RuntimeError(f"Failed to queue notification for user {user_id}: {e}") from e
    finally:
        cursor.close()
        connection.close()


@activity.defn
async def record_payment_audit(payment_id: int, action: str, details: dict) -> bool:
    """
    Append an entry to the real `payment_gateway_logs` audit trail
    (drizzle paymentGatewayLogs, physical table payment_gateway_logs).
    The gateway is resolved from the payment's recorded paymentMethod.
    Raises on any failure: the workflow must never report success for a
    payment that has no audit trail.
    """
    logger.info(f"Recording audit log for payment {payment_id}: {action}")
    connection = get_db_connection()
    cursor = connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cursor.execute('SELECT "paymentMethod" FROM payments WHERE id = %s', (payment_id,))
        row = cursor.fetchone()
        if not row:
            raise ValueError(f"Cannot record audit: payment {payment_id} not found")
        gateway = row['paymentMethod']
        # payment_gateway_logs.gateway enum: mpesa/airtel_money/tigo_pesa
        if gateway not in ('mpesa', 'airtel_money', 'tigo_pesa'):
            raise ValueError(
                f"Cannot record gateway audit for payment {payment_id}: "
                f"paymentMethod '{gateway}' is not a mobile-money gateway"
            )

        # payment_gateway_logs.status enum: pending/success/failed/timeout
        action_status_map = {
            'payment_completed': 'success',
            'payment_failed': 'failed',
            'verification_timeout': 'timeout',
        }
        if action in action_status_map:
            log_status = action_status_map[action]
        elif details.get('status') == 'completed':
            log_status = 'success'
        elif details.get('status') == 'failed':
            log_status = 'failed'
        else:
            log_status = 'pending'

        error_message = None
        if log_status in ('failed', 'timeout'):
            error_message = details.get('error') or details.get('result_desc')

        cursor.execute(
            """INSERT INTO payment_gateway_logs
               (payment_id, gateway, request_type, response_payload, status, error_message, created_at)
               VALUES (%s, %s, %s, %s, %s, %s, NOW())""",
            (payment_id, gateway, action[:50], json.dumps(details), log_status, error_message),
        )
        connection.commit()
        return True
    except Error as e:
        connection.rollback()
        raise RuntimeError(f"Failed to record audit log for payment {payment_id}: {e}") from e
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
    cursor = connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        # payments has no `gateway` column; the gateway is payments.paymentMethod
        # (enum: mpesa/airtel_money/tigo_pesa/bank_transfer/card).
        cursor.execute(
            'SELECT "paymentMethod", "transactionId", amount, "phoneNumber", status FROM payments WHERE id = %s',
            (payment_id,),
        )
        payment = cursor.fetchone()
        if not payment:
            raise ValueError(f"Payment {payment_id} not found for refund")
        if payment['status'] != 'completed':
            raise RuntimeError(
                f"Cannot refund payment {payment_id}: status is '{payment['status']}', "
                "only 'completed' payments can be refunded"
            )

        gateway = payment['paymentMethod']
        transaction_id = payment.get('transactionId') or ''
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
                if data.get('ResponseCode') != '0':
                    raise RuntimeError(
                        f"M-Pesa reversal rejected for payment {payment_id} "
                        f"(txn: {transaction_id}): {data}"
                    )
        else:
            # Airtel/Tigo/bank/card refunds cannot be executed through an
            # automated reversal API here; they require manual processing via
            # the provider portal. Record the request honestly in metadata and
            # keep status 'completed' (the money has NOT been returned yet).
            # payments.status enum is pending/completed/failed/refunded —
            # 'refund_pending' is not a valid state and is not used.
            logger.warning(
                f"Automated refund not supported for gateway '{gateway}'. "
                f"Payment {payment_id} (txn: {transaction_id}) flagged for manual refund."
            )
            cursor.execute(
                """UPDATE payments
                   SET metadata = jsonb_set(
                       jsonb_set(
                           COALESCE(metadata::jsonb, '{}'::jsonb),
                           '{refundStatus}', '"manual_review_required"'::jsonb, true
                       ),
                       '{refundReason}', to_jsonb(%s::text), true
                   )::text, "updatedAt" = NOW()
                   WHERE id = %s""",
                (reason, payment_id),
            )
            connection.commit()
            return True

        # M-Pesa reversal accepted by the gateway.
        cursor.execute(
            'UPDATE payments SET status = \'refunded\', "updatedAt" = NOW() WHERE id = %s',
            (payment_id,),
        )
        connection.commit()
        logger.info(f"Refund initiated for payment {payment_id}")
        return True

    except Error as e:
        connection.rollback()
        raise RuntimeError(f"Refund failed for payment {payment_id}: {e}") from e
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
                    updated = await workflow.execute_activity(
                        update_payment_status,
                        args=[input.payment_id, 'completed', transaction_id, status_response],
                        start_to_close_timeout=timedelta(seconds=30),
                    )
                    if not updated:
                        raise RuntimeError(
                            f"Payment {input.payment_id} completed at gateway but DB status update failed"
                        )
                    notified = await workflow.execute_activity(
                        send_payment_notification,
                        args=[input.user_id, input.payment_id, 'completed', input.amount],
                        start_to_close_timeout=timedelta(seconds=30),
                    )
                    if not notified:
                        raise RuntimeError(
                            f"Payment {input.payment_id} completed but notification could not be queued"
                        )
                    # The workflow must not report success without an audit trail.
                    audited = await workflow.execute_activity(
                        record_payment_audit,
                        args=[input.payment_id, 'payment_completed', status_response],
                        start_to_close_timeout=timedelta(seconds=30),
                    )
                    if not audited:
                        raise RuntimeError(
                            f"Payment {input.payment_id} completed but audit trail write failed"
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
                        record_payment_audit,
                        args=[input.payment_id, 'payment_failed', status_response],
                        start_to_close_timeout=timedelta(seconds=30),
                    )
                    await workflow.execute_activity(
                        send_payment_notification,
                        args=[input.user_id, input.payment_id, 'failed', input.amount],
                        start_to_close_timeout=timedelta(seconds=30),
                    )
                    logger.warning(f"Payment {input.payment_id} failed: {result.error}")
                    return result

                # Still pending — workflow-safe wait before next poll
                await workflow.sleep(poll_interval.total_seconds())

            # Poll window exhausted without a terminal gateway/callback status.
            # The payment must not stay stuck in 'pending': mark it failed with
            # reason 'verification_timeout' and record the audit trail entry.
            result.status = 'failed'
            result.error = 'verification_timeout'
            await workflow.execute_activity(
                update_payment_status,
                args=[input.payment_id, 'failed', transaction_id,
                      {'error': 'verification_timeout',
                       'detail': 'No terminal status received within the poll window'}],
                start_to_close_timeout=timedelta(seconds=30),
            )
            await workflow.execute_activity(
                record_payment_audit,
                args=[input.payment_id, 'verification_timeout',
                      {'transaction_id': transaction_id, 'error': 'verification_timeout'}],
                start_to_close_timeout=timedelta(seconds=30),
            )
            await workflow.execute_activity(
                send_payment_notification,
                args=[input.user_id, input.payment_id, 'failed', input.amount],
                start_to_close_timeout=timedelta(seconds=30),
            )
            logger.warning(f"Payment {input.payment_id} verification timeout — marked failed")
            return result

        except Exception as e:
            logger.error(f"Payment processing error: {e}")
            result.error = str(e)
            if result.status != 'completed':
                # Only downgrade payments that never reached a terminal success.
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
            # Fail the workflow run loudly — Temporal records the failure
            # instead of a swallowed "successful" result.
            raise


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def validate_gateway_config():
    """
    Fail fast at worker startup if required gateway configuration is missing.
    MPESA_BASE_URL in particular selects sandbox vs production and must be
    an explicit operator decision — it is never defaulted.
    """
    required = (
        'MPESA_BASE_URL',
        'MPESA_CONSUMER_KEY',
        'MPESA_CONSUMER_SECRET',
        'MPESA_SHORTCODE',
        'MPESA_PASSKEY',
        'MPESA_CALLBACK_URL',
    )
    missing = [name for name in required if not os.getenv(name)]
    if missing:
        raise RuntimeError(
            "Missing required payment gateway environment variables: "
            + ", ".join(missing)
        )


async def main():
    """Start the payment worker."""
    validate_gateway_config()
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
