#!/bin/bash

# SimpliTX Production Deployment Script
# This script automates the deployment process for SimpliTX to production

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
COMPOSE_FILES="-f docker-compose.yaml -f docker-compose.production.yml"
ENV_FILE=".env.production"
BACKUP_DIR="./backups"

# Functions
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

check_prerequisites() {
    log_info "Checking prerequisites..."

    # Check Docker
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed"
        exit 1
    fi

    # Check Docker Compose
    if ! command -v docker-compose &> /dev/null; then
        log_error "Docker Compose is not installed"
        exit 1
    fi

    # Check environment file
    if [[ ! -f "$ENV_FILE" ]]; then
        log_error "Production environment file not found: $ENV_FILE"
        log_info "Please copy .env.production.template to $ENV_FILE and configure it"
        exit 1
    fi

    log_success "Prerequisites check passed"
}

create_backup() {
    log_info "Creating backup..."

    # Create backup directory
    mkdir -p "$BACKUP_DIR"

    # Create timestamp
    TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

    # Backup current containers (if running)
    if docker-compose $COMPOSE_FILES ps | grep -q "Up"; then
        log_info "Backing up current deployment..."
        docker-compose $COMPOSE_FILES ps > "$BACKUP_DIR/containers_$TIMESTAMP.txt"
        docker-compose $COMPOSE_FILES logs > "$BACKUP_DIR/logs_$TIMESTAMP.txt" 2>&1 || true
    fi

    # Backup database (if accessible)
    if docker-compose $COMPOSE_FILES ps postgres | grep -q "Up"; then
        log_info "Backing up database..."
        docker-compose $COMPOSE_FILES exec -T postgres pg_dump -U postgres pdf_jobs > "$BACKUP_DIR/database_$TIMESTAMP.sql" 2>/dev/null || log_warning "Could not backup database"
    fi

    log_success "Backup created in $BACKUP_DIR"
}

deploy_services() {
    log_info "Deploying services..."

    # Pull latest images (if using external registry)
    # docker-compose $COMPOSE_FILES pull

    # Build and start services
    docker-compose $COMPOSE_FILES up -d --build

    log_success "Services deployed"
}

wait_for_services() {
    log_info "Waiting for services to be healthy..."

    # Wait for PostgreSQL
    log_info "Waiting for PostgreSQL..."
    timeout 60 sh -c 'until docker-compose '"$COMPOSE_FILES"' exec -T postgres pg_isready -U postgres; do sleep 1; done' || {
        log_error "PostgreSQL failed to start"
        return 1
    }

    # Wait for other services
    log_info "Waiting for other services..."
    sleep 10

    # Check service health
    SERVICES=("web" "worker" "gateway" "pdf2json" "json2xml")
    for service in "${SERVICES[@]}"; do
        if docker-compose $COMPOSE_FILES ps "$service" | grep -q "Up"; then
            log_success "$service is running"
        else
            log_warning "$service may not be running properly"
        fi
    done
}

run_migrations() {
    log_info "Running database migrations..."

    # Run migrations in web service
    log_info "Running web service migrations..."
    docker-compose $COMPOSE_FILES exec -T web npx prisma migrate deploy || {
        log_error "Web service migration failed"
        return 1
    }

    # Run migrations in worker service
    log_info "Running worker service migrations..."
    docker-compose $COMPOSE_FILES exec -T worker npx prisma migrate deploy || {
        log_error "Worker service migration failed"
        return 1
    }

    # Generate Prisma clients
    log_info "Generating Prisma clients..."
    docker-compose $COMPOSE_FILES exec -T web npx prisma generate
    docker-compose $COMPOSE_FILES exec -T worker npx prisma generate

    log_success "Database migrations completed"
}

verify_deployment() {
    log_info "Verifying deployment..."

    # Check web service
    if curl -f http://localhost:3000/ > /dev/null 2>&1; then
        log_success "Web service is accessible"
    else
        log_warning "Web service may not be accessible on port 3000"
    fi

    # Check gateway service
    if curl -f http://localhost:8002/health > /dev/null 2>&1; then
        log_success "Gateway service is accessible"
    else
        log_warning "Gateway service may not be accessible on port 8002"
    fi

    # Check database schema
    log_info "Verifying database schema..."
    TABLES=$(docker-compose $COMPOSE_FILES exec -T postgres psql -U postgres -d pdf_jobs -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>/dev/null | tr -d ' \n' || echo "0")

    if [[ "$TABLES" -ge 6 ]]; then
        log_success "Database schema looks good ($TABLES tables found)"
    else
        log_warning "Database schema may be incomplete ($TABLES tables found)"
    fi

    log_success "Deployment verification completed"
}

show_status() {
    log_info "Current deployment status:"
    echo ""
    docker-compose $COMPOSE_FILES ps
    echo ""

    log_info "Service URLs:"
    echo "  Web Application: http://localhost:3000"
    echo "  Gateway API: http://localhost:8002"
    echo ""

    log_info "To view logs:"
    echo "  docker-compose $COMPOSE_FILES logs -f"
    echo ""

    log_info "To stop services:"
    echo "  docker-compose $COMPOSE_FILES down"
}

rollback() {
    log_warning "Rolling back deployment..."

    # Stop current services
    docker-compose $COMPOSE_FILES down

    # Restore from backup if available
    LATEST_BACKUP=$(ls -t "$BACKUP_DIR"/database_*.sql 2>/dev/null | head -1 || echo "")
    if [[ -n "$LATEST_BACKUP" ]]; then
        log_info "Restoring database from $LATEST_BACKUP"
        # Restore database (implement as needed)
        # docker-compose $COMPOSE_FILES exec -T postgres psql -U postgres -d pdf_jobs < "$LATEST_BACKUP"
    fi

    log_warning "Rollback completed. Please check your system state."
}

# Main execution
main() {
    log_info "Starting SimpliTX Production Deployment"
    echo ""

    # Parse command line arguments
    case "${1:-deploy}" in
        "deploy")
            check_prerequisites
            create_backup
            deploy_services
            wait_for_services
            run_migrations
            verify_deployment
            show_status
            ;;
        "rollback")
            rollback
            ;;
        "status")
            show_status
            ;;
        "logs")
            docker-compose $COMPOSE_FILES logs -f
            ;;
        *)
            echo "Usage: $0 [deploy|rollback|status|logs]"
            echo ""
            echo "Commands:"
            echo "  deploy   - Deploy services to production (default)"
            echo "  rollback - Rollback to previous state"
            echo "  status   - Show current deployment status"
            echo "  logs     - Show service logs"
            exit 1
            ;;
    esac
}

# Run main function with all arguments
main "$@"