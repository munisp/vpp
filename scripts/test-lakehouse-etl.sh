#!/bin/bash
#
# Lakehouse ingestion tests.
#
# This script used to check that files existed and that a venv directory was
# present, and printed PASS for each — which said nothing about whether ingestion
# works. It now runs the package's actual test suite.
#
# The PostgreSQL pipeline tests need a database. Set LAKEHOUSE_TEST_DSN to include
# them; without it they are skipped, and this script says so rather than implying
# the database paths were covered.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_DIR="$PROJECT_DIR/services/lakehouse"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

PYTHON=${PYTHON:-python3}

echo "========================================="
echo "Lakehouse ingestion tests"
echo "========================================="
echo ""

if ! "$PYTHON" -c "import pyarrow.parquet, boto3, psycopg2, pytest" 2>/dev/null; then
  echo -e "${RED}✗ Dependencies missing.${NC}"
  echo "  Install them first:"
  echo "    $PYTHON -m pip install -r $SERVICE_DIR/requirements.txt \\"
  echo "                        -r $SERVICE_DIR/requirements-dev.txt"
  exit 1
fi

if [ -n "${LAKEHOUSE_TEST_DSN:-}" ]; then
  echo -e "${GREEN}LAKEHOUSE_TEST_DSN is set${NC} — real-PostgreSQL pipeline tests included."
else
  echo -e "${YELLOW}LAKEHOUSE_TEST_DSN is not set${NC} — pipeline tests against a real"
  echo "database will be SKIPPED. Encoding, object-store and config tests still run."
fi
echo ""

cd "$SERVICE_DIR"
if "$PYTHON" -m pytest -q; then
  echo ""
  echo -e "${GREEN}Lakehouse ingestion tests passed.${NC}"
  exit 0
fi

echo ""
echo -e "${RED}Lakehouse ingestion tests failed.${NC}"
exit 1
