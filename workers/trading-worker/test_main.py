import asyncio
import unittest
from unittest.mock import patch

import main


class FakeCursor:
    def __init__(self, row):
        self.row = row
        self.executed = []
        self.closed = False

    def execute(self, query, params):
        self.executed.append((query, params))

    def fetchone(self):
        return self.row

    def close(self):
        self.closed = True


class FakeConnection:
    def __init__(self, cursor):
        self._cursor = cursor
        self.commits = 0
        self.rollbacks = 0
        self.closed = False

    def cursor(self):
        return self._cursor

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed = True


class TestAtomicOrderFills(unittest.TestCase):
    def test_fill_uses_a_conditional_atomic_update(self):
        cursor = FakeCursor((7, 0, "executed"))
        connection = FakeConnection(cursor)

        with patch.object(main, "get_db_connection", return_value=connection):
            self.assertTrue(asyncio.run(main.update_order_status(7, 2.5)))

        query, params = cursor.executed[0]
        self.assertIn("UPDATE trades", query)
        self.assertIn("status = 'pending'", query)
        self.assertIn("energy >= %s", query)
        self.assertIn("RETURNING id, energy, status", query)
        self.assertEqual(params, (2500, 2500, 7, 2500))
        self.assertEqual(connection.commits, 1)
        self.assertEqual(connection.rollbacks, 0)
        self.assertTrue(cursor.closed)
        self.assertTrue(connection.closed)

    def test_stale_or_oversized_fill_rolls_back_and_refuses(self):
        cursor = FakeCursor(None)
        connection = FakeConnection(cursor)

        with patch.object(main, "get_db_connection", return_value=connection):
            with self.assertRaisesRegex(RuntimeError, "stale, duplicate, or over-sized fill"):
                asyncio.run(main.update_order_status(7, 2.5))

        self.assertEqual(connection.commits, 0)
        self.assertEqual(connection.rollbacks, 1)
        self.assertTrue(cursor.closed)
        self.assertTrue(connection.closed)

    def test_nonpositive_fills_are_refused_before_database_access(self):
        with self.assertRaisesRegex(ValueError, "positive whole-Wh"):
            asyncio.run(main.update_order_status(7, 0))


if __name__ == "__main__":
    unittest.main()
