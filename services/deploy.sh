#!/bin/bash

set -e

echo "=== VPP MQTT-Fluvio Integration Deployment ==="
echo

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "Error: Docker is not installed"
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    echo "Error: docker-compose is not installed"
    exit 1
fi

# Load environment variables
if [ -f .env ]; then
    echo "Loading environment variables from .env"
    export $(cat .env | grep -v '^#' | xargs)
else
    echo "Warning: .env file not found"
fi

# Build images
echo "Building Docker images..."
docker-compose build

# Start services
echo "Starting services..."
docker-compose up -d

# Wait for services to be healthy
echo "Waiting for services to start..."
sleep 10

# Check service status
echo
echo "Service Status:"
docker-compose ps

# Show logs
echo
echo "Recent logs:"
docker-compose logs --tail=20

echo
echo "=== Deployment Complete ==="
echo
echo "Services:"
echo "  - Mosquitto MQTT: localhost:1883 (plain), localhost:8883 (TLS)"
echo "  - Fluvio: localhost:9003"
echo "  - MQTT-Fluvio Bridge: running"
echo "  - Database Consumer: running"
echo "  - Analytics Consumer: running"
echo
echo "To view logs: docker-compose logs -f [service-name]"
echo "To stop: docker-compose down"
echo
