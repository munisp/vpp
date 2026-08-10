#!/bin/bash

set -e

echo "========================================="
echo "Creating Kafka Topics for VPP Platform"
echo "========================================="
echo ""

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

KAFKA_CONTAINER="kafka"
TOPICS=(
    "vpp.trading.orders"
    "vpp.trading.executions"
    "vpp.trading.p2p"
    "vpp.dr.events"
    "vpp.dr.participation"
    "vpp.dr.forecasts"
    "vpp.payments.transactions"
    "vpp.payments.receipts"
    "vpp.telemetry.raw"
    "vpp.telemetry.processed"
    "vpp.alerts.system"
    "vpp.alerts.user"
    "vpp.gamification.achievements"
    "vpp.gamification.leaderboard"
    "vpp.notifications.push"
    "vpp.workflows.events"
)

echo -e "${YELLOW}Creating Kafka topics...${NC}"
echo ""

for topic in "${TOPICS[@]}"; do
    echo "Creating topic: $topic"
    docker exec $KAFKA_CONTAINER kafka-topics \
        --create \
        --if-not-exists \
        --bootstrap-server localhost:9092 \
        --replication-factor 1 \
        --partitions 3 \
        --topic $topic || true
done

echo ""
echo -e "${GREEN}✓ All topics created${NC}"
echo ""

echo "Listing all topics:"
docker exec $KAFKA_CONTAINER kafka-topics \
    --list \
    --bootstrap-server localhost:9092

echo ""
echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}Kafka Topics Setup Complete!${NC}"
echo -e "${GREEN}=========================================${NC}"
echo ""
