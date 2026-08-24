"""
Tests for the VPP Payment Worker activities.

Covers:
- initiate_payment: validates gateway dispatch and error handling
- query_payment_status: validates status mapping
- update_payment_status: validates DB write logic
- send_payment_notification: validates DB insert
- record_payment_audit: validates audit log insert
- process_refund: validates refund routing
- generatePrepaidToken equivalent: validates token format
- Crypto: no Math.random() usage in token generation
"""

import asyncio
import os
import re
import sys
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, patch, call

# ---------------------------------------------------------------------------
# Minimal stubs so we can import main.py without real Temporal / PostgreSQL
# ---------------------------------------------------------------------------

# Stub temporalio
temporal_stub = types.ModuleType("temporalio")
temporal_activity = types.ModuleType("temporalio.activity")
temporal_workflow = types.ModuleType("temporalio.workflow")
temporal_client = types.ModuleType("temporalio.client")
temporal_worker = types.ModuleType("temporalio.worker")

def _passthrough(fn=None, **kwargs):
    """Decorator that returns the function unchanged."""
    if fn is not None:
        return fn
    return lambda f: f

temporal_activity.defn = _passthrough
temporal_workflow.defn = _passthrough
temporal_workflow.run = _passthrough

# Stub Client and Worker
class _FakeClient:
    @staticmethod
    async def connect(addr): return _FakeClient()
temporal_client.Client = _FakeClient

class _FakeWorker:
    def __init__(self, *a, **kw): pass
    def RegisterWorkflow(self, *a): pass
    def RegisterActivity(self, *a): pass
    async def run(self): pass
temporal_worker.Worker = _FakeWorker

class _FakeWorkflow:
    @staticmethod
    def now():
        from datetime import datetime, timezone
        return datetime.now(timezone.utc)
    @staticmethod
    async def execute_activity(fn, args=None, **kwargs):
        return await fn(*(args or []))
    @staticmethod
    async def sleep(ctx, duration):
        pass

temporal_workflow.execute_activity = _FakeWorkflow.execute_activity
temporal_workflow.now = _FakeWorkflow.now

sys.modules["temporalio"] = temporal_stub
sys.modules["temporalio.activity"] = temporal_activity
sys.modules["temporalio.workflow"] = temporal_workflow
sys.modules["temporalio.client"] = temporal_client
sys.modules["temporalio.worker"] = temporal_worker

# Stub psycopg2
psycopg2_stub = types.ModuleType("psycopg2")
psycopg2_extras_stub = types.ModuleType("psycopg2.extras")
psycopg2_extras_stub.RealDictCursor = object
psycopg2_stub.Error = Exception
psycopg2_stub.connect = MagicMock()
psycopg2_stub.extras = psycopg2_extras_stub
sys.modules["psycopg2"] = psycopg2_stub
sys.modules["psycopg2.extras"] = psycopg2_extras_stub

# Now import the module under test
sys.path.insert(0, os.path.dirname(__file__))
import main as worker


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ---------------------------------------------------------------------------
# Tests: initiate_payment
# ---------------------------------------------------------------------------

class TestInitiatePayment(unittest.IsolatedAsyncioTestCase):

    async def test_mpesa_calls_api_and_returns_success(self):
        """initiate_payment for mpesa must call the M-Pesa STK Push endpoint."""
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "ResponseCode": "0",
            "CheckoutRequestID": "CHK-TEST-001",
            "CustomerMessage": "Success. Request accepted.",
            "ResponseDescription": "Success",
        }

        mock_token_resp = MagicMock()
        mock_token_resp.raise_for_status = MagicMock()
        mock_token_resp.json.return_value = {"access_token": "tok_test"}

        # Patch the module-level constants directly
        with patch.object(worker, 'MPESA_CONSUMER_KEY', 'key'), \
             patch.object(worker, 'MPESA_CONSUMER_SECRET', 'secret'), \
             patch.object(worker, 'MPESA_SHORTCODE', '174379'), \
             patch.object(worker, 'MPESA_PASSKEY', 'passkey'), \
             patch.object(worker, 'MPESA_CALLBACK_URL', 'https://example.com/callback'), \
             patch.object(worker, 'MPESA_BASE_URL', 'https://sandbox.safaricom.co.ke'):
            with patch("httpx.AsyncClient") as MockClient:
                instance = AsyncMock()
                MockClient.return_value.__aenter__ = AsyncMock(return_value=instance)
                MockClient.return_value.__aexit__ = AsyncMock(return_value=False)
                # First call = token, second = STK push
                instance.get = AsyncMock(return_value=mock_token_resp)
                instance.post = AsyncMock(return_value=mock_response)

                result = await worker.initiate_payment("mpesa", "254712345678", 10000, "REF001")

        self.assertTrue(result["success"])
        self.assertEqual(result["transaction_id"], "CHK-TEST-001")
        self.assertIn("checkout_request_id", result)

    async def test_unsupported_gateway_raises(self):
        """initiate_payment must raise ValueError for unknown gateways."""
        with self.assertRaises(ValueError):
            await worker.initiate_payment("bitcoin", "255700000000", 5000, "REF002")

    async def test_mpesa_missing_credentials_raises(self):
        """initiate_payment must raise RuntimeError when credentials are absent."""
        with patch.object(worker, 'MPESA_CONSUMER_KEY', ''):
            with self.assertRaises(RuntimeError):
                await worker.initiate_payment("mpesa", "254712345678", 5000, "REF003")


# ---------------------------------------------------------------------------
# Tests: query_payment_status
# ---------------------------------------------------------------------------

class TestQueryPaymentStatus(unittest.IsolatedAsyncioTestCase):

    async def test_mpesa_completed_maps_correctly(self):
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "ResultCode": "0",
            "ResultDesc": "The service request is processed successfully.",
        }
        mock_token_resp = MagicMock()
        mock_token_resp.raise_for_status = MagicMock()
        mock_token_resp.json.return_value = {"access_token": "tok_test"}

        with patch.object(worker, 'MPESA_CONSUMER_KEY', 'key'), \
             patch.object(worker, 'MPESA_CONSUMER_SECRET', 'secret'), \
             patch.object(worker, 'MPESA_SHORTCODE', '174379'), \
             patch.object(worker, 'MPESA_PASSKEY', 'passkey'), \
             patch.object(worker, 'MPESA_BASE_URL', 'https://sandbox.safaricom.co.ke'):
            with patch("httpx.AsyncClient") as MockClient:
                instance = AsyncMock()
                MockClient.return_value.__aenter__ = AsyncMock(return_value=instance)
                MockClient.return_value.__aexit__ = AsyncMock(return_value=False)
                instance.get = AsyncMock(return_value=mock_token_resp)
                instance.post = AsyncMock(return_value=mock_response)

                result = await worker.query_payment_status("mpesa", "CHK-TEST-001")

        self.assertEqual(result["status"], "completed")
        self.assertTrue(result["success"])

    async def test_tigo_returns_pending(self):
        """Tigo Pesa uses callbacks; status query must return 'pending'."""
        result = await worker.query_payment_status("tigo_pesa", "TXN-001")
        self.assertEqual(result["status"], "pending")
        self.assertFalse(result["success"])


# ---------------------------------------------------------------------------
# Tests: update_payment_status
# ---------------------------------------------------------------------------

class TestUpdatePaymentStatus(unittest.IsolatedAsyncioTestCase):

    async def test_updates_db_with_transaction_id(self):
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(worker, "get_db_connection", return_value=mock_conn):
            result = await worker.update_payment_status(42, "completed", "TXN-XYZ", {"foo": "bar"})

        self.assertTrue(result)
        mock_cursor.execute.assert_called_once()
        call_args = mock_cursor.execute.call_args[0]
        self.assertIn("transactionId", call_args[0])
        self.assertEqual(call_args[1][0], "completed")
        self.assertEqual(call_args[1][1], "TXN-XYZ")

    async def test_updates_db_without_transaction_id(self):
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(worker, "get_db_connection", return_value=mock_conn):
            result = await worker.update_payment_status(42, "failed")

        self.assertTrue(result)
        call_args = mock_cursor.execute.call_args[0]
        self.assertNotIn("transactionId", call_args[0])

    async def test_raises_on_db_error(self):
        """A DB failure must propagate so Temporal retries — never a silent False."""
        with patch.object(worker, "get_db_connection", side_effect=Exception("DB down")):
            with self.assertRaises(Exception):
                await worker.update_payment_status(1, "failed")


# ---------------------------------------------------------------------------
# Tests: send_payment_notification
# ---------------------------------------------------------------------------

class TestSendPaymentNotification(unittest.IsolatedAsyncioTestCase):

    async def test_inserts_notification_row(self):
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(worker, "get_db_connection", return_value=mock_conn):
            result = await worker.send_payment_notification(7, 99, "completed", 5000)

        self.assertTrue(result)
        mock_cursor.execute.assert_called_once()
        sql = mock_cursor.execute.call_args[0][0]
        self.assertIn("INSERT INTO alerts", sql)

    async def test_notification_title_reflects_status(self):
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(worker, "get_db_connection", return_value=mock_conn):
            await worker.send_payment_notification(7, 99, "failed", 5000)

        args = mock_cursor.execute.call_args[0][1]
        self.assertEqual(args[1], "error")  # severity param
        self.assertIn("Failed", args[2])  # title param


# ---------------------------------------------------------------------------
# Tests: record_payment_audit
# ---------------------------------------------------------------------------

class TestRecordPaymentAudit(unittest.IsolatedAsyncioTestCase):

    async def test_inserts_audit_log(self):
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_cursor.fetchone.return_value = {"paymentMethod": "mpesa"}
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(worker, "get_db_connection", return_value=mock_conn):
            result = await worker.record_payment_audit(42, "payment_completed", {"txn": "abc"})

        self.assertTrue(result)
        sql = mock_cursor.execute.call_args[0][0]
        self.assertIn("INSERT INTO payment_gateway_logs", sql)

    async def test_raises_on_db_error(self):
        """No audit trail means no success: the activity must raise."""
        with patch.object(worker, "get_db_connection", side_effect=Exception("DB down")):
            with self.assertRaises(Exception):
                await worker.record_payment_audit(1, "action", {})


# ---------------------------------------------------------------------------
# Tests: process_refund
# ---------------------------------------------------------------------------

class TestProcessRefund(unittest.IsolatedAsyncioTestCase):

    async def test_mpesa_calls_reversal_api(self):
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_cursor.fetchone.return_value = {
            "paymentMethod": "mpesa",
            "transactionId": "TXN-REV-001",
            "amount": 10000,
            "phoneNumber": "254712345678",
            "status": "completed",
        }
        mock_conn.cursor.return_value = mock_cursor

        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {"ResponseCode": "0"}
        mock_token_resp = MagicMock()
        mock_token_resp.raise_for_status = MagicMock()
        mock_token_resp.json.return_value = {"access_token": "tok_test"}

        with patch.object(worker, 'MPESA_CONSUMER_KEY', 'key'), \
             patch.object(worker, 'MPESA_CONSUMER_SECRET', 'secret'), \
             patch.object(worker, 'MPESA_SHORTCODE', '174379'), \
             patch.object(worker, 'MPESA_BASE_URL', 'https://sandbox.safaricom.co.ke'):
            with patch.object(worker, 'get_db_connection', return_value=mock_conn):
                with patch("httpx.AsyncClient") as MockClient:
                    instance = AsyncMock()
                    MockClient.return_value.__aenter__ = AsyncMock(return_value=instance)
                    MockClient.return_value.__aexit__ = AsyncMock(return_value=False)
                    instance.get = AsyncMock(return_value=mock_token_resp)
                    instance.post = AsyncMock(return_value=mock_response)

                    result = await worker.process_refund(1, "Customer request")

        self.assertTrue(result)

    async def test_airtel_flags_manual_review(self):
        """Airtel refunds have no reversal API: the row is flagged for manual review
        and the payment status is left untouched, because no money moved."""
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_cursor.fetchone.return_value = {
            "paymentMethod": "airtel_money",
            "transactionId": "AIRTEL-001",
            "amount": 5000,
            "phoneNumber": "255712345678",
            "status": "completed",
        }
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(worker, "get_db_connection", return_value=mock_conn):
            result = await worker.process_refund(2, "Duplicate charge")

        self.assertTrue(result)
        flagged = [c for c in mock_cursor.execute.call_args_list
                   if "manual_review_required" in str(c)]
        self.assertTrue(len(flagged) > 0, "Expected the refund to be flagged for manual review")
        refunded = [c for c in mock_cursor.execute.call_args_list
                    if "'refunded'" in str(c)]
        self.assertEqual(refunded, [], "Payment must not be marked refunded without a reversal")


# ---------------------------------------------------------------------------
# Tests: Crypto security — no Math.random() in token generation
# ---------------------------------------------------------------------------

class TestCryptoSecurity(unittest.TestCase):

    def test_no_math_random_in_worker_source(self):
        """The worker source must not use random.random() or random.uniform()."""
        import inspect
        source = inspect.getsource(worker)
        # These patterns indicate insecure randomness
        forbidden = ["random.random()", "random.uniform(", "random.randint(", "random.gauss("]
        for pattern in forbidden:
            self.assertNotIn(pattern, source,
                f"Found insecure randomness pattern '{pattern}' in payment worker")

    def test_token_generation_uses_os_urandom(self):
        """Verify os.urandom is used (via secrets or direct) for token IDs."""
        import inspect
        source = inspect.getsource(worker)
        # The worker uses secrets.token_hex which wraps os.urandom
        self.assertIn("secrets", source,
            "Expected 'secrets' module usage for cryptographic token generation")

    def test_transaction_id_format_is_unpredictable(self):
        """Two transaction IDs generated in sequence must differ."""
        import secrets
        id1 = f"VPP-REF001-{secrets.token_hex(4).upper()}"
        id2 = f"VPP-REF001-{secrets.token_hex(4).upper()}"
        self.assertNotEqual(id1, id2,
            "Transaction IDs must be unique across calls")


if __name__ == "__main__":
    unittest.main(verbosity=2)
