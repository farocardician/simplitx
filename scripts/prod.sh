#!/bin/bash
set -e

echo "Starting production environment..."

# Stop any existing containers
docker-compose -f docker-compose.yaml -f docker-compose.production.yml down

# Build and start production environment
docker-compose -f docker-compose.yaml -f docker-compose.production.yml up --build -d

echo "Production environment started successfully!"
echo "Access the application at: http://localhost:3000"
echo "Gateway API at: http://localhost:8002"