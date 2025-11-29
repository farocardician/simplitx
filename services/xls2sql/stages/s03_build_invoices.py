#!/usr/bin/env python3
"""
Stage s03 - Build normalized invoices.

Responsibility:
- Read validated rows from public."temporaryStaging"
- Join with public.parties for buyer information
- Group by (invoice, buyer_party_id)
- Populate tax_invoices (invoice headers)
- Populate tax_invoice_items (line items with HS/UOM resolution and tax calculations)

This script does NOT generate XML. XML generation is handled by a separate script.

Usage:
    python s03_build_invoices.py --job-id <uuid>
    python s03_build_invoices.py --invoice <invoice_number>
    python s03_build_invoices.py --job-id <uuid> --dry-run
"""

import argparse
import json
import logging
import os
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List, Optional

import psycopg2
from psycopg2 import sql
from psycopg2.extras import Json, RealDictCursor

# Import helper functions
from invoice_helpers import (
    parse_hs_code,
    validate_hs_code,
    resolve_uom,
    compute_item_calculations,
    get_buyer_name
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Database connection config from environment (no fallbacks)
def _get_db_config():
    """Get database config from environment variables.

    Checks both PGHOST/PGPORT/etc and DB_HOST/DB_PORT/etc variants.

    Raises:
        RuntimeError if required database environment variables are not set
    """
    host = os.getenv('PGHOST') or os.getenv('DB_HOST')
    port = os.getenv('PGPORT') or os.getenv('DB_PORT')
    database = os.getenv('PGDATABASE') or os.getenv('DB_NAME')
    user = os.getenv('PGUSER') or os.getenv('DB_USER')
    password = os.getenv('PGPASSWORD') or os.getenv('DB_PASSWORD')

    missing = []
    if not host:
        missing.append('PGHOST or DB_HOST')
    if not port:
        missing.append('PGPORT or DB_PORT')
    if not database:
        missing.append('PGDATABASE or DB_NAME')
    if not user:
        missing.append('PGUSER or DB_USER')
    if not password:
        missing.append('PGPASSWORD or DB_PASSWORD')

    if missing:
        raise RuntimeError(
            f"Missing required database environment variables: {missing}. "
            f"Set the appropriate environment variable(s)."
        )

    return {
        'host': host,
        'port': int(port),
        'database': database,
        'user': user,
        'password': password,
    }

DB_CONFIG = _get_db_config()

# Constants will be loaded from config


def _repo_root() -> Path:
    """Locate repository root based on current file.

    Works in both local development (services/xls2sql/stages/) and Docker (/xls2sql/stages/, /app/stages/).
    Searches upward for .git directory or uses environment variable.
    """
    # Check if REPO_ROOT is set in environment
    repo_root_env = os.getenv('REPO_ROOT')
    if repo_root_env:
        return Path(repo_root_env)

    # Search upward for .git directory
    current = Path(__file__).resolve()
    for parent in [current] + list(current.parents):
        if (parent / '.git').exists():
            return parent

    # Fallback: try to detect based on path structure
    current_path = Path(__file__).resolve()
    current_str = str(current_path)

    # Docker environments
    if current_str.startswith('/xls2sql'):
        # Script at /xls2sql/stages/ - config is at /app/services/config/
        return Path('/app')
    elif current_str.startswith('/app'):
        # Script at /app/... - root is /app
        return Path('/app')

    # Local development - check if we have enough parent directories
    try:
        return current_path.parents[3]
    except IndexError:
        # Not enough parents, return root
        return Path('/')


def _get_job_config(conn, job_id: str) -> Dict[str, Any]:
    """Fetch pipeline config metadata from job_config."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            "SELECT config_name, seller_id FROM public.job_config WHERE job_id = %s",
            (job_id,)
        )
        row = cur.fetchone()

    if not row:
        raise RuntimeError(
            f"Job {job_id} not found in job_config table. "
            "Ensure the job was created with s01_postgreimport_sensient.py --config <config_name>"
        )

    return dict(row)


def _load_pipeline_config(config_name: str) -> Dict[str, Any]:
    """
    Load pipeline config to source VAT rate and other knobs.

    Args:
        config_name: Pipeline config filename (e.g., invoice_pt_client.json)

    Returns:
        Parsed config dictionary

    Raises:
        RuntimeError if config cannot be loaded
    """
    # Ensure config_name has .json extension
    if not config_name.endswith('.json'):
        config_name = f"{config_name}.json"

    candidate_paths = []

    provided = Path(config_name)
    if provided.is_absolute():
        candidate_paths.append(provided)
    else:
        # Check if CONFIG_DIR is set (common in Docker)
        config_dir = os.getenv("CONFIG_DIR")
        if config_dir:
            candidate_paths.append(Path(config_dir) / config_name)

        repo_root = _repo_root()
        current_file = Path(__file__).resolve()

        # Add various candidate paths for different environments
        candidate_paths.extend([
            # Standard repo structure
            repo_root / "services" / "config" / config_name,
            repo_root / "config" / config_name,
            repo_root / config_name,
            # Relative to current file (works in Docker when mounted at /xls2sql)
            current_file.parent.parent / "config" / config_name,  # /xls2sql/config/
            current_file.parent.parent.parent / "config" / config_name,  # /config/
            # Legacy fallback
            current_file.parents[2] / "config" / config_name,
        ])

    for path in candidate_paths:
        if not path.exists():
            continue
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"Failed to load pipeline config from {path}: {exc}") from exc

    raise RuntimeError(f"Pipeline config '{config_name}' not found in expected locations: {candidate_paths}")


def _load_vat_rate(config: Dict[str, Any]) -> Decimal:
    """Derive VAT rate from config; require presence to avoid hidden defaults."""
    vat_value = None

    if isinstance(config, dict):
        tax_conf = config.get("tax") or {}
        vat_value = tax_conf.get("vat_rate")
        if vat_value is None:
            vat_value = config.get("vat_rate")

    if vat_value is None:
        raise RuntimeError("VAT rate missing in pipeline config (expected tax.vat_rate)")

    vat_decimal = Decimal(str(vat_value))
    if vat_decimal <= 0:
        raise RuntimeError("VAT rate in pipeline config must be positive")
    return vat_decimal


def _load_seller_config(config: Dict[str, Any]) -> Dict[str, str]:
    """Load seller configuration from pipeline config dict."""
    seller_conf = config.get("seller")

    if not seller_conf or not isinstance(seller_conf, dict):
        raise RuntimeError(
            "Missing 'seller' section in pipeline config. "
            "Expected seller object with fields: id, tax_invoice_opt"
        )

    required_fields = ["id", "tax_invoice_opt"]
    missing = [f for f in required_fields if f not in seller_conf]

    if missing:
        raise RuntimeError(
            f"Missing required seller config fields: {missing}. "
            f"Expected keys in 'seller' section: {required_fields}"
        )

    # Validate non-empty strings
    for field in required_fields:
        value = seller_conf[field]
        if not isinstance(value, str) or not value.strip():
            raise RuntimeError(
                f"seller.{field} must be a non-empty string, got: {repr(value)}"
            )

    return {
        "id": seller_conf["id"],
        "tax_invoice_opt": seller_conf["tax_invoice_opt"]
    }


def fetch_seller_party(conn, seller_id: str) -> Dict[str, Any]:
    """Fetch seller party details from public.parties.

    Args:
        conn: Database connection
        seller_id: UUID of seller party

    Returns:
        Dict with seller details (tin_normalized, seller_idtku, tax_invoice_opt)

    Raises:
        RuntimeError if seller not found
    """
    query = """
    SELECT
        id,
        tin_normalized,
        seller_idtku,
        tax_invoice_opt
    FROM public.parties
    WHERE id = %s AND deleted_at IS NULL
    LIMIT 1
    """

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(query, (seller_id,))
        seller = cur.fetchone()

    if not seller:
        raise RuntimeError(
            f"Seller party not found in database: {seller_id}. "
            "Ensure seller party exists in parties table."
        )

    if not seller['tin_normalized']:
        raise RuntimeError(
            f"Seller party {seller_id} has no TIN. "
            "tin_normalized must be set in parties table."
        )

    if not seller['seller_idtku']:
        raise RuntimeError(
            f"Seller party {seller_id} has no IDTKU. "
            "seller_idtku must be set in parties table."
        )

    return seller


def get_db_connection():
    """Create and return a database connection."""
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        return conn
    except Exception as e:
        logger.error(f"Failed to connect to database: {e}")
        sys.exit(1)


def ensure_tax_invoices_columns(conn):
    """Add is_complete and missing_fields columns if they do not exist."""
    alter_sql = """
    ALTER TABLE tax_invoices
        ADD COLUMN IF NOT EXISTS is_complete boolean,
        ADD COLUMN IF NOT EXISTS missing_fields jsonb;
    ALTER TABLE tax_invoices
        ALTER COLUMN buyer_party_id DROP NOT NULL;
    """
    with conn.cursor() as cur:
        cur.execute(alter_sql)
    conn.commit()


def get_invoices_to_process(
    conn,
    job_id: Optional[str] = None,
    invoice_number: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    Get unique (invoice, buyer_party_id) groups from temporaryStaging.
    Skip groups that already exist in tax_invoices.

    Args:
        conn: Database connection
        job_id: Optional filter by job_id
        invoice_number: Optional filter by specific invoice

    Returns:
        List of dict with keys: invoice, buyer_party_id, ship_date, count
    """
    where_clauses = []
    params = []

    if job_id:
        where_clauses.append("ts.job_id = %s")
        params.append(job_id)

    if invoice_number:
        where_clauses.append("ts.invoice = %s")
        params.append(invoice_number)

    where_sql = "WHERE " + " AND ".join(where_clauses) if where_clauses else ""

    query = f"""
    SELECT
        ts.invoice,
        ts.buyer_party_id,
        ts.job_id,
        MIN(ts.ship_date) as ship_date,
        COUNT(*) as item_count
    FROM public."temporaryStaging" ts
    {where_sql}
    GROUP BY ts.invoice, ts.buyer_party_id, ts.job_id
    HAVING NOT EXISTS (
        SELECT 1 FROM tax_invoices ti
        WHERE ti.invoice_number = ts.invoice
          AND ti.buyer_party_id IS NOT DISTINCT FROM ts.buyer_party_id
    )
    ORDER BY ts.invoice
    """

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(query, params)
        return cur.fetchall()


def fetch_buyer_party(conn, buyer_party_id: str) -> Optional[Dict[str, Any]]:
    """
    Fetch buyer party details from public.parties.

    Args:
        conn: Database connection
        buyer_party_id: UUID of buyer party

    Returns:
        Dict with buyer details or None if not found
    """
    query = """
    SELECT
        id,
        name_normalized,
        display_name,
        tin_normalized,
        country_code,
        transaction_code,
        address_full,
        email,
        buyer_idtku,
        buyer_document,
        buyer_document_number
    FROM public.parties
    WHERE id = %s AND deleted_at IS NULL
    """

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(query, (buyer_party_id,))
        return cur.fetchone()


def fetch_staging_items(
    conn,
    invoice_number: str,
    buyer_party_id: Optional[str]
) -> List[Dict[str, Any]]:
    """
    Fetch all staging rows for a given (invoice, buyer_party_id).

    Args:
        conn: Database connection
        invoice_number: Invoice number
        buyer_party_id: Buyer party UUID

    Returns:
        List of staging row dicts
    """
    query = """
    SELECT
        id,
        invoice,
        ship_date,
        hs_code,
        item_description,
        input_uom,
        unit_price,
        total_kg,
        job_id,
        buyer_name_raw
    FROM public."temporaryStaging"
    WHERE invoice = %s AND buyer_party_id IS NOT DISTINCT FROM %s
    ORDER BY id
    """

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(query, (invoice_number, buyer_party_id))
        return cur.fetchall()


def upsert_tax_invoice(
    conn,
    invoice_data: Dict[str, Any],
    dry_run: bool = False
) -> Optional[str]:
    """
    UPSERT a tax_invoices record.
    Uses (invoice_number, buyer_party_id) as conflict key.

    Args:
        conn: Database connection
        invoice_data: Dict with invoice header fields
        dry_run: If True, log but don't execute

    Returns:
        tax_invoice_id (UUID) or None if dry_run
    """
    # Handle NULL buyer_party_id safely (IS NOT DISTINCT FROM) so re-runs update instead of duplicating.
    select_query = """
    SELECT id FROM tax_invoices
    WHERE invoice_number = %(invoice_number)s
      AND buyer_party_id IS NOT DISTINCT FROM %(buyer_party_id)s
    LIMIT 1
    """

    insert_query = """
    INSERT INTO tax_invoices (
        job_id,
        invoice_number,
        buyer_party_id,
        tax_invoice_date,
        tax_invoice_opt,
        ref_desc,
        is_complete,
        missing_fields
    ) VALUES (
        %(job_id)s,
        %(invoice_number)s,
        %(buyer_party_id)s,
        %(tax_invoice_date)s,
        %(tax_invoice_opt)s,
        %(ref_desc)s,
        %(is_complete)s,
        %(missing_fields)s
    )
    RETURNING id
    """

    update_query = """
    UPDATE tax_invoices
    SET
        job_id = %(job_id)s,
        tax_invoice_date = %(tax_invoice_date)s,
        tax_invoice_opt = %(tax_invoice_opt)s,
        ref_desc = %(ref_desc)s,
        is_complete = %(is_complete)s,
        missing_fields = %(missing_fields)s,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = %(existing_id)s
    RETURNING id
    """

    if dry_run:
        logger.info(f"[DRY RUN] Would UPSERT tax_invoice: {invoice_data['invoice_number']}")
        return None

    with conn.cursor() as cur:
        cur.execute(select_query, invoice_data)
        existing = cur.fetchone()
        if existing:
            invoice_data["existing_id"] = existing[0]
            cur.execute(update_query, invoice_data)
            result = cur.fetchone()
            return result[0] if result else existing[0]

        cur.execute(insert_query, invoice_data)
        result = cur.fetchone()
        return result[0] if result else None


def delete_existing_items(conn, tax_invoice_id: str, dry_run: bool = False):
    """
    Delete existing tax_invoice_items for idempotency.

    Args:
        conn: Database connection
        tax_invoice_id: UUID of tax_invoice
        dry_run: If True, log but don't execute
    """
    if dry_run:
        logger.info(f"[DRY RUN] Would DELETE existing items for tax_invoice_id: {tax_invoice_id}")
        return

    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM tax_invoice_items WHERE tax_invoice_id = %s",
            (tax_invoice_id,)
        )
        deleted_count = cur.rowcount
        if deleted_count > 0:
            logger.debug(f"Deleted {deleted_count} existing items for invoice {tax_invoice_id}")


def insert_tax_invoice_items(
    conn,
    tax_invoice_id: str,
    items_data: List[Dict[str, Any]],
    dry_run: bool = False
) -> int:
    """
    Insert tax_invoice_items for an invoice.

    Args:
        conn: Database connection
        tax_invoice_id: UUID of parent tax_invoice
        items_data: List of item dicts
        dry_run: If True, log but don't execute

    Returns:
        Number of items inserted
    """
    if dry_run:
        logger.info(f"[DRY RUN] Would INSERT {len(items_data)} items for tax_invoice_id: {tax_invoice_id}")
        return 0

    insert_query = """
    INSERT INTO tax_invoice_items (
        tax_invoice_id,
        line_number,
        opt,
        code,
        name,
        unit,
        price,
        qty,
        total_discount,
        tax_base,
        other_tax_base,
        vat_rate,
        vat
    ) VALUES (
        %(tax_invoice_id)s,
        %(line_number)s,
        %(opt)s,
        %(code)s,
        %(name)s,
        %(unit)s,
        %(price)s,
        %(qty)s,
        %(total_discount)s,
        %(tax_base)s,
        %(other_tax_base)s,
        %(vat_rate)s,
        %(vat)s
    )
    """

    with conn.cursor() as cur:
        for item in items_data:
            cur.execute(insert_query, item)

    return len(items_data)


def cleanup_staging_job(conn, job_id: str, dry_run: bool = False):
    """
    Delete staging rows for a successfully processed job.

    Args:
        conn: Database connection
        job_id: UUID of job to clean up
        dry_run: If True, log but don't execute
    """
    if dry_run:
        logger.info(f"[DRY RUN] Would DELETE staging rows for job_id: {job_id}")
        return

    with conn.cursor() as cur:
        cur.execute(
            'DELETE FROM public."temporaryStaging" WHERE job_id = %s',
            (job_id,)
        )
        deleted_count = cur.rowcount
        logger.info(f"✓ Cleaned up {deleted_count} staging rows for job {job_id}")


def compute_missing_fields(
    buyer_party_id: Optional[str],
    buyer: Optional[Dict[str, Any]],
    buyer_name_raw_present: bool
) -> List[str]:
    """Identify missing critical buyer fields for completeness tracking."""
    missing = []

    if not buyer_party_id:
        missing.append('buyer_party_id')

    buyer_name = None
    buyer_tin = None
    buyer_document = None
    buyer_country = None
    buyer_address = None
    buyer_idtku = None
    trx_code = None

    if buyer:
        buyer_name = buyer.get('display_name') or buyer.get('name_normalized')
        buyer_tin = buyer.get('tin_normalized')
        buyer_document = buyer.get('buyer_document') or 'TIN'
        buyer_country = buyer.get('country_code')
        buyer_address = buyer.get('address_full')
        buyer_idtku = buyer.get('buyer_idtku')
        trx_code = buyer.get('transaction_code')

    if not trx_code or (isinstance(trx_code, str) and not trx_code.strip()):
        missing.append('trx_code')
    if not buyer_tin or (isinstance(buyer_tin, str) and not buyer_tin.strip()):
        missing.append('buyer_tin')
    if not buyer_document or (isinstance(buyer_document, str) and not buyer_document.strip()):
        missing.append('buyer_document')
    if not buyer_country or (isinstance(buyer_country, str) and not buyer_country.strip()):
        missing.append('buyer_country')
    if not buyer_address or (isinstance(buyer_address, str) and not buyer_address.strip()):
        missing.append('buyer_address')
    if not buyer_idtku or (isinstance(buyer_idtku, str) and not buyer_idtku.strip()):
        missing.append('buyer_idtku')

    # Handle buyer_name separately based on raw presence
    if not buyer_name:
        if not buyer_name_raw_present:
            missing.append('buyer_name')

    return missing


def process_invoice_group(
    conn,
    invoice_number: str,
    buyer_party_id: Optional[str],
    ship_date: str,
    job_id: str,
    dry_run: bool = False,
    job_config_cache: Optional[Dict] = None,
    pipeline_config_cache: Optional[Dict] = None,
    seller_cache: Optional[Dict] = None,
    buyers_cache: Optional[Dict] = None
) -> bool:
    """
    Process one (invoice, buyer_party_id) group.

    Steps:
    1. Load config from job_id (or use cache)
    2. Fetch seller party (or use cache)
    3. Fetch buyer party details (or use cache)
    4. Fetch staging items
    5. Validate and resolve HS codes and UOMs
    6. UPSERT tax_invoice
    7. Delete existing items (if not dry_run)
    8. Insert new tax_invoice_items

    Args:
        conn: Database connection
        invoice_number: Invoice number
        buyer_party_id: Buyer party UUID
        ship_date: Invoice date
        job_id: Job UUID for config lookup
        dry_run: If True, log but don't commit
        job_config_cache: Pre-loaded job_config row (optimization)
        pipeline_config_cache: Pre-loaded pipeline config (optimization)
        seller_cache: Pre-loaded seller party (optimization)
        buyers_cache: Pre-loaded buyers dict (optimization)

    Returns:
        True if successful, False otherwise
    """
    logger.info(f"Processing invoice: {invoice_number}, buyer: {buyer_party_id}, job: {job_id}")

    try:
        # 0. Load config + job metadata (use cache if available)
        job_config = job_config_cache or _get_job_config(conn, job_id)
        pipeline_config = pipeline_config_cache or _load_pipeline_config(job_config["config_name"])
        vat_rate = _load_vat_rate(pipeline_config)
        seller_id = job_config.get("seller_id") or pipeline_config.get("seller", {}).get("id")
        if not seller_id:
            raise RuntimeError(f"No seller_id configured for job {job_id}")

        # 1. Fetch seller party info (use cache if available)
        seller = None
        if seller_cache and seller_cache.get("id") == seller_id:
            seller = seller_cache
        else:
            seller = fetch_seller_party(conn, seller_id)

        # 2. Fetch buyer party (use cache if available)
        buyer = None
        if buyer_party_id:
            if buyers_cache is not None and buyer_party_id in buyers_cache:
                buyer = buyers_cache[buyer_party_id]
            else:
                buyer = fetch_buyer_party(conn, buyer_party_id)
            if not buyer:
                logger.warning(f"Buyer party not found: {buyer_party_id} (will proceed with NULL buyer fields)")

        # 2. Fetch staging items
        staging_items = fetch_staging_items(conn, invoice_number, buyer_party_id)
        if not staging_items:
            logger.warning(f"No staging items found for invoice: {invoice_number}")
            return False

        logger.info(f"  Found {len(staging_items)} items")

        # 3. Prepare invoice header data
        buyer_name_raw = staging_items[0].get('buyer_name_raw')
        buyer_name = None
        if buyer:
            buyer_name = buyer.get('name_normalized') or buyer.get('display_name')
        elif buyer_name_raw:
            buyer_name = str(buyer_name_raw).strip() or None
        invoice_data = {
            'job_id': staging_items[0]['job_id'],
            'invoice_number': invoice_number,
            'buyer_party_id': buyer_party_id,
            'tax_invoice_date': ship_date,
            'tax_invoice_opt': seller.get('tax_invoice_opt') or pipeline_config.get('seller', {}).get('tax_invoice_opt'),
            'ref_desc': invoice_number,  # Same as invoice_number
        }
        if not invoice_data['tax_invoice_opt']:
            raise RuntimeError("Seller tax_invoice_opt missing in parties or pipeline config")
        missing_fields = compute_missing_fields(
            buyer_party_id,
            buyer,
            bool(buyer_name_raw)
        )
        invoice_data['is_complete'] = len(missing_fields) == 0
        invoice_data['missing_fields'] = Json(missing_fields)

        # 4. UPSERT tax_invoice
        tax_invoice_id = upsert_tax_invoice(conn, invoice_data, dry_run)
        if not tax_invoice_id and not dry_run:
            logger.error(f"Failed to UPSERT tax_invoice for {invoice_number}")
            return False

        # Use a temporary ID for dry-run
        if dry_run:
            tax_invoice_id = "DRY_RUN_ID"

        # 5. Process items
        items_data = []
        errors = []
        has_invalid_hs_codes = False  # Track if any items have invalid/missing HS codes

        for idx, staging_item in enumerate(staging_items, start=1):
            # Parse and validate HS code
            opt, code = parse_hs_code(staging_item['hs_code'])
            if not code:
                error_msg = f"  ⚠️  Invalid/missing HS code: {staging_item['hs_code']} (row {staging_item['id']}) - importing with NULL, must be fixed in UI"
                logger.warning(error_msg)
                errors.append(error_msg)
                # Don't skip - import with NULL code so user can fix in UI
                code = None
                opt = None
                has_invalid_hs_codes = True  # Mark invoice as incomplete

            if code and not dry_run and not validate_hs_code(code, conn):
                error_msg = f"  ⚠️  HS code not found in hs_codes table: {code} (row {staging_item['id']}) - importing anyway, must be fixed in UI"
                logger.warning(error_msg)
                errors.append(error_msg)
                # Continue anyway - let UI handle validation
                has_invalid_hs_codes = True  # Mark invoice as incomplete

            # Resolve UOM
            uom_code = resolve_uom(staging_item['input_uom'], conn)
            if not uom_code:
                error_msg = f"  ⚠️  UOM not resolved: {staging_item['input_uom']} (row {staging_item['id']})"
                logger.warning(error_msg)
                errors.append(error_msg)
                # Use original as fallback
                uom_code = staging_item['input_uom']

            # Calculate tax fields
            price = Decimal(str(staging_item['unit_price']))
            qty = Decimal(str(staging_item['total_kg']))
            calculations = compute_item_calculations(price, qty, vat_rate)

            item_data = {
                'tax_invoice_id': tax_invoice_id,
                'line_number': idx,
                'opt': opt or None,
                'code': code,
                'name': staging_item['item_description'],
                'unit': uom_code,
                'price': price,
                'qty': qty,
                'total_discount': Decimal('0'),
                'tax_base': calculations['tax_base'],
                'other_tax_base': calculations['other_tax_base'],
                'vat_rate': vat_rate,
                'vat': calculations['vat'],
            }

            items_data.append(item_data)

        # 6. Delete existing items and insert new ones
        if not dry_run:
            delete_existing_items(conn, tax_invoice_id)

        inserted_count = insert_tax_invoice_items(conn, tax_invoice_id, items_data, dry_run)

        # 7. Update invoice completeness if there are HS code issues
        if has_invalid_hs_codes and not dry_run:
            # Add HS code issues to missing_fields
            updated_missing_fields = list(missing_fields)  # Copy existing missing fields
            if 'hs_codes' not in updated_missing_fields:
                updated_missing_fields.append('hs_codes')

            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE tax_invoices
                    SET is_complete = FALSE,
                        missing_fields = %s,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = %s
                    """,
                    (Json(updated_missing_fields), tax_invoice_id)
                )
            logger.info(f"  ⚠️  Marked invoice as incomplete due to invalid/missing HS codes")

        logger.info(f"  ✓ Processed {inserted_count} items")
        if errors:
            logger.warning(f"  ⚠️  {len(errors)} errors/warnings during processing")

        return True

    except Exception as e:
        logger.error(f"Error processing invoice {invoice_number}: {e}")
        import traceback
        traceback.print_exc()
        try:
            conn.rollback()
        except Exception:
            pass
        return False


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description='Build normalized invoices from temporaryStaging'
    )
    parser.add_argument(
        '--job-id',
        help='Process specific job UUID'
    )
    parser.add_argument(
        '--invoice',
        help='Process specific invoice number'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Show what would be done without committing'
    )

    args = parser.parse_args()

    if not args.job_id and not args.invoice:
        logger.error("Error: Must specify either --job-id or --invoice")
        sys.exit(1)

    logger.info("=" * 70)
    logger.info("  INVOICE NORMALIZATION (s03)")
    logger.info("=" * 70)
    if args.dry_run:
        logger.info("  MODE: DRY RUN (no changes will be committed)")
    logger.info("")

    import time
    script_start = time.time()

    # Connect to database
    t1 = time.time()
    logger.info("⏱️  Connecting to database...")
    conn = get_db_connection()
    conn.autocommit = False  # Use transactions
    logger.info(f"✓ Database connected in {(time.time() - t1)*1000:.0f}ms")

    t2 = time.time()
    logger.info("⏱️  Ensuring tax_invoices columns...")
    ensure_tax_invoices_columns(conn)
    logger.info(f"✓ Columns checked in {(time.time() - t2)*1000:.0f}ms")

    try:
        # Get invoices to process
        t3 = time.time()
        logger.info("⏱️  Querying invoices to process...")
        invoices = get_invoices_to_process(conn, args.job_id, args.invoice)
        logger.info(f"✓ Query completed in {(time.time() - t3)*1000:.0f}ms")

        if not invoices:
            logger.info("No invoices to process (all may already exist in tax_invoices)")
            logger.info(f"⏱️  Total script time: {(time.time() - script_start)*1000:.0f}ms")
            return

        logger.info(f"Found {len(invoices)} invoice groups to process")
        logger.info("")

        # OPTIMIZATION: Pre-load config and seller (same for all invoices in job)
        t_cache = time.time()
        logger.info("⏱️  Pre-loading config and seller...")
        job_config_cache = None
        pipeline_config_cache = None
        seller_cache = None
        if args.job_id:
            try:
                job_config_cache = _get_job_config(conn, args.job_id)
                pipeline_config_cache = _load_pipeline_config(job_config_cache["config_name"])
                seller_id = job_config_cache.get("seller_id") or pipeline_config_cache.get("seller", {}).get("id")
                seller_cache = fetch_seller_party(conn, seller_id) if seller_id else None
                logger.info(f"✓ Config/seller cached in {(time.time() - t_cache)*1000:.0f}ms")
            except Exception as e:
                logger.warning(f"Could not cache config/seller: {e}, will load per invoice")
                seller_cache = None
                job_config_cache = None
                pipeline_config_cache = None

        # OPTIMIZATION: Batch fetch all unique buyers
        t_buyers = time.time()
        unique_buyer_ids = list(set(inv['buyer_party_id'] for inv in invoices if inv['buyer_party_id']))
        logger.info(f"⏱️  Batch fetching {len(unique_buyer_ids)} unique buyers...")
        buyers_cache = {}
        if unique_buyer_ids:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                # Cast to UUID array for PostgreSQL
                cur.execute("""
                    SELECT id, name_normalized, display_name, tin_normalized,
                           country_code, transaction_code, address_full, email,
                           buyer_idtku, buyer_document, buyer_document_number
                    FROM public.parties
                    WHERE id = ANY(%s::uuid[]) AND deleted_at IS NULL
                """, (unique_buyer_ids,))
                for row in cur.fetchall():
                    buyers_cache[row['id']] = dict(row)
        logger.info(f"✓ Buyers cached in {(time.time() - t_buyers)*1000:.0f}ms")

        # Process each invoice group
        success_count = 0
        error_count = 0

        t4 = time.time()
        logger.info(f"⏱️  Processing {len(invoices)} invoice groups...")
        for inv in invoices:
            success = process_invoice_group(
                conn,
                inv['invoice'],
                inv['buyer_party_id'],
                inv['ship_date'],
                inv['job_id'],
                args.dry_run,
                job_config_cache=job_config_cache,
                pipeline_config_cache=pipeline_config_cache,
                seller_cache=seller_cache,
                buyers_cache=buyers_cache
            )

            if success:
                success_count += 1
            else:
                error_count += 1
        logger.info(f"✓ All invoices processed in {(time.time() - t4)*1000:.0f}ms")

        # Commit if not dry-run
        if not args.dry_run:
            t5 = time.time()
            logger.info("⏱️  Committing transaction...")
            conn.commit()
            logger.info(f"✓ Transaction committed in {(time.time() - t5)*1000:.0f}ms")
            logger.info("")

            # Clean up staging data for this job
            if args.job_id:
                t6 = time.time()
                logger.info("⏱️  Cleaning up staging data...")
                cleanup_staging_job(conn, args.job_id, dry_run=False)
                conn.commit()  # Commit the cleanup deletion
                logger.info(f"✓ Cleanup completed in {(time.time() - t6)*1000:.0f}ms")
        else:
            conn.rollback()
            logger.info("")
            logger.info("✓ Transaction rolled back (dry-run)")

        # Print summary
        logger.info("")
        logger.info("=" * 70)
        logger.info("  SUMMARY")
        logger.info("=" * 70)
        logger.info(f"Invoices processed successfully: {success_count}")
        logger.info(f"Invoices with errors:          {error_count}")
        logger.info(f"⏱️  TOTAL SCRIPT TIME:          {(time.time() - script_start)*1000:.0f}ms")
        logger.info("=" * 70)

    except Exception as e:
        conn.rollback()
        logger.error(f"Fatal error: {e}")
        logger.error(f"⏱️  Failed after {(time.time() - script_start)*1000:.0f}ms")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
