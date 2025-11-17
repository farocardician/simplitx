#!/bin/bash
set -e

echo "Starting development environment..."

# Stop any existing containers
docker-compose -f docker-compose.yaml -f docker-compose.development.yml down

# Build and start development environment
docker-compose -f docker-compose.yaml -f docker-compose.development.yml up --build