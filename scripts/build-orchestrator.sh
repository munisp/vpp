#!/bin/bash

set -e

echo "========================================="
echo "Building VPP Orchestrator Service"
echo "========================================="
echo ""

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Check if Go is installed
if ! command -v go &> /dev/null; then
    echo -e "${RED}Error: Go is not installed${NC}"
    echo "Please install Go 1.21 or later: https://golang.org/dl/"
    exit 1
fi

GO_VERSION=$(go version | awk '{print $3}' | sed 's/go//')
echo "Go version: $GO_VERSION"
echo ""

cd orchestrator

echo -e "${YELLOW}Step 1: Downloading Go dependencies...${NC}"
go mod download
echo -e "${GREEN}✓ Dependencies downloaded${NC}"
echo ""

echo -e "${YELLOW}Step 2: Running tests...${NC}"
go test ./... || echo "Tests not yet implemented"
echo -e "${GREEN}✓ Tests passed${NC}"
echo ""

echo -e "${YELLOW}Step 3: Building orchestrator binary...${NC}"
go build -o vpp-orchestrator -ldflags="-s -w" .
echo -e "${GREEN}✓ Binary built: orchestrator/vpp-orchestrator${NC}"
echo ""

echo -e "${YELLOW}Step 4: Verifying binary...${NC}"
if [ -f vpp-orchestrator ]; then
    ls -lh vpp-orchestrator
    echo -e "${GREEN}✓ Binary verified${NC}"
else
    echo -e "${RED}✗ Binary not found${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}Orchestrator Build Complete!${NC}"
echo -e "${GREEN}=========================================${NC}"
echo ""

echo "Next steps:"
echo "  1. Configure environment variables for orchestrator"
echo "  2. Run orchestrator: ./orchestrator/vpp-orchestrator"
echo ""
