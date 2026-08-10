#!/bin/bash

set -e

echo "========================================="
echo "VPP External Services Deployment"
echo "========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker is not installed${NC}"
    echo "Please install Docker first: https://docs.docker.com/get-docker/"
    exit 1
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo -e "${RED}Error: Docker Compose is not installed${NC}"
    echo "Please install Docker Compose first: https://docs.docker.com/compose/install/"
    exit 1
fi

echo -e "${YELLOW}Step 1: Creating necessary directories...${NC}"
mkdir -p temporal-config

echo -e "${YELLOW}Step 2: Creating Temporal dynamic config...${NC}"
cat > temporal-config/development-sql.yaml << 'YAML'
system.forceSearchAttributesCacheRefreshOnRead:
  - value: true
    constraints: {}
YAML

echo -e "${GREEN}✓ Configuration files created${NC}"
echo ""

echo -e "${YELLOW}Step 3: Starting external services with Docker Compose...${NC}"
echo "This may take several minutes on first run..."
echo ""

# Use docker compose (new) or docker-compose (old)
if docker compose version &> /dev/null; then
    COMPOSE_CMD="docker compose"
else
    COMPOSE_CMD="docker-compose"
fi

$COMPOSE_CMD -f docker-compose.external-services.yml up -d

echo ""
echo -e "${GREEN}✓ Services started${NC}"
echo ""

echo -e "${YELLOW}Step 4: Waiting for services to be healthy...${NC}"
echo "This may take 1-2 minutes..."
echo ""

# Wait for services
sleep 10

# Check service health
echo "Checking service health:"
echo ""

check_service() {
    local service=$1
    local port=$2
    local name=$3
    
    if nc -z localhost $port 2>/dev/null; then
        echo -e "  ${GREEN}✓${NC} $name (port $port)"
        return 0
    else
        echo -e "  ${RED}✗${NC} $name (port $port) - not ready"
        return 1
    fi
}

# Check all services
check_service temporal 7233 "Temporal Server"
check_service temporal-web 8233 "Temporal Web UI"
check_service kafka 29092 "Kafka"
check_service redis 6379 "Redis"
check_service keycloak 8080 "Keycloak"
check_service tigerbeetle 3000 "TigerBeetle"
check_service dapr-placement 50005 "Dapr Placement"
check_service fluvio 9003 "Fluvio"

echo ""
echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}External Services Deployment Complete!${NC}"
echo -e "${GREEN}=========================================${NC}"
echo ""

echo "Service URLs:"
echo "  • Temporal Web UI:    http://localhost:8233"
echo "  • Kafka UI:           http://localhost:8090"
echo "  • Redis Commander:    http://localhost:8091"
echo "  • Keycloak Admin:     http://localhost:8080 (admin/admin)"
echo ""

echo "Next steps:"
echo "  1. Configure Keycloak realm: ./scripts/setup-keycloak.sh"
echo "  2. Initialize TigerBeetle: ./scripts/init-tigerbeetle.sh"
echo "  3. Create Kafka topics: ./scripts/create-kafka-topics.sh"
echo "  4. Build orchestrator: cd orchestrator && go build"
echo "  5. Start orchestrator: ./orchestrator/vpp-orchestrator"
echo ""

echo "To view logs:"
echo "  $COMPOSE_CMD -f docker-compose.external-services.yml logs -f [service-name]"
echo ""

echo "To stop services:"
echo "  $COMPOSE_CMD -f docker-compose.external-services.yml down"
echo ""
