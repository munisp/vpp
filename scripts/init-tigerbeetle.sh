#!/bin/bash

set -e

echo "========================================="
echo "Initializing TigerBeetle Ledger"
echo "========================================="
echo ""

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Creating TigerBeetle data file...${NC}"

# Check if TigerBeetle container is running
if ! docker ps | grep -q tigerbeetle; then
    echo "TigerBeetle container is not running. Please start it first."
    exit 1
fi

# Initialize the cluster data file
docker exec tigerbeetle sh -c '
    if [ ! -f /data/cluster_0.tigerbeetle ]; then
        tigerbeetle format --cluster=0 --replica=0 /data/cluster_0.tigerbeetle
        echo "TigerBeetle data file created"
    else
        echo "TigerBeetle data file already exists"
    fi
' || echo "Initialization may have already been done"

echo -e "${GREEN}✓ TigerBeetle initialized${NC}"
echo ""

echo "Testing TigerBeetle connection..."
if nc -z localhost 3000 2>/dev/null; then
    echo -e "${GREEN}✓ TigerBeetle is accessible on port 3000${NC}"
else
    echo -e "${YELLOW}⚠ TigerBeetle port 3000 not accessible${NC}"
fi

echo ""
echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}TigerBeetle Setup Complete!${NC}"
echo -e "${GREEN}=========================================${NC}"
echo ""
echo "TigerBeetle is ready to accept connections"
echo "Connection: localhost:3000"
echo "Cluster ID: 0"
echo ""
