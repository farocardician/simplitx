#!/bin/bash

# UOM Import Script
# Imports Unit of Measure codes from uom.csv into the database
# Usage: ./scripts/importUom.sh [path/to/uom.csv]

set -e  # Exit on any error

# Configuration
CSV_FILE="${1:-uom.csv}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if CSV file exists
if [[ ! -f "$CSV_FILE" ]]; then
    log_error "CSV file not found: $CSV_FILE"
    log_info "Usage: ./scripts/importUom.sh [path/to/uom.csv]"
    log_info "If no path is provided, will look for uom.csv in current directory"
    exit 1
fi

log_info "Starting UOM import from: $CSV_FILE"

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    log_error "Docker is not running. Please start Docker and try again."
    exit 1
fi

# Check if containers are running
log_info "Checking if containers are running..."
if ! docker-compose -f docker-compose.yaml -f docker-compose.development.yml ps | grep -q "web.*Up.*healthy"; then
    log_error "Web container is not running or not healthy."
    log_info "Please start the containers with: docker-compose -f docker-compose.yaml -f docker-compose.development.yml up -d"
    exit 1
fi

# Count lines in CSV (excluding potential header)
TOTAL_LINES=$(wc -l < "$CSV_FILE")
log_info "Found $TOTAL_LINES lines in CSV file"

# Create temporary SQL file for import
TEMP_SQL="/tmp/import_uom_$$.sql"
log_info "Generating SQL statements..."

# Generate SQL INSERT statements from CSV
{
    echo "-- UOM Import generated at $(date)"
    echo "-- Source file: $CSV_FILE"
    echo ""
    echo "BEGIN;"
    echo ""

    # Read CSV and generate INSERT statements
    while IFS=',' read -r code name; do
        # Skip empty lines
        [[ -z "$code" ]] && continue

        # Trim whitespace and quotes
        code=$(echo "$code" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | sed 's/^"//;s/"$//')
        name=$(echo "$name" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | sed 's/^"//;s/"$//')

        # Skip if code or name is empty
        [[ -z "$code" || -z "$name" ]] && continue

        # Escape single quotes in name for SQL
        name=$(echo "$name" | sed "s/'/''/g")

        echo "INSERT INTO uom_codes (code, name, created_at, updated_at)"
        echo "VALUES ('$code', '$name', NOW(), NOW())"
        echo "ON CONFLICT (code) DO UPDATE SET"
        echo "  name = EXCLUDED.name,"
        echo "  updated_at = NOW();"
        echo ""

    done < "$CSV_FILE"

    echo "COMMIT;"
    echo ""
    echo "-- Import completed"

} > "$TEMP_SQL"

# Count generated INSERT statements
INSERT_COUNT=$(grep -c "INSERT INTO uom_codes" "$TEMP_SQL" || true)
log_info "Generated $INSERT_COUNT INSERT statements"

if [[ $INSERT_COUNT -eq 0 ]]; then
    log_error "No valid data found in CSV file"
    rm -f "$TEMP_SQL"
    exit 1
fi

# Show first few statements for review
log_info "Preview of generated SQL (first 10 lines):"
head -20 "$TEMP_SQL" | sed 's/^/  /'
echo "  ..."

# Ask for confirmation
echo ""
read -p "Do you want to proceed with importing $INSERT_COUNT UOM records? (y/N): " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    log_warning "Import cancelled by user"
    rm -f "$TEMP_SQL"
    exit 0
fi

# Copy SQL file to container and execute
log_info "Copying SQL file to container..."
docker cp "$TEMP_SQL" $(docker-compose -f docker-compose.yaml -f docker-compose.development.yml ps -q postgres):/tmp/import_uom.sql

log_info "Executing import..."
docker-compose -f docker-compose.yaml -f docker-compose.development.yml exec -T postgres psql -U postgres -d pdf_jobs -f /tmp/import_uom.sql

# Check if import was successful
if [[ $? -eq 0 ]]; then
    log_success "UOM import completed successfully!"

    # Get count of records in database
    RECORD_COUNT=$(docker-compose -f docker-compose.yaml -f docker-compose.development.yml exec -T postgres psql -U postgres -d pdf_jobs -t -c "SELECT COUNT(*) FROM uom_codes;" | tr -d ' \n\r')
    log_success "Total UOM records in database: $RECORD_COUNT"

    # Show some sample records
    log_info "Sample imported records:"
    docker-compose -f docker-compose.yaml -f docker-compose.development.yml exec -T postgres psql -U postgres -d pdf_jobs -c "SELECT code, name FROM uom_codes ORDER BY code LIMIT 5;"

else
    log_error "Import failed!"
    exit 1
fi

# Cleanup
log_info "Cleaning up temporary files..."
rm -f "$TEMP_SQL"
docker-compose -f docker-compose.yaml -f docker-compose.development.yml exec postgres rm -f /tmp/import_uom.sql

log_success "UOM import process completed!"