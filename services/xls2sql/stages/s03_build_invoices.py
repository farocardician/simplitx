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
    python s03_build_invoices.py --batch-id <uuid>
    python s03_build_invoices.py --invoice <invoice_number>
    python s03_build_invoices.py --batch-id <uuid> --dry-run
"""

import argparse
import logging
import os
import sys
from decimal import Decimal
from typing import List, Dict, Any, Optional
import psycopg2
from psycopg2 import sql
from psycopg2.extras import RealDictCursor

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

# Database connection config from environment
DB_CONFIG = {
    'host': os.getenv('PGHOST') or os.getenv('DB_HOST', 'localhost'),
    'port': int(os.getenv('PGPORT') or os.getenv('DB_PORT', '5432')),
    'database': os.getenv('PGDATABASE') or os.getenv('DB_NAME', 'pdf_jobs'),
    'user': os.getenv('PGUSER') or os.getenv('DB_USER', 'postgres'),
    'password': os.getenv('PGPASSWORD') or os.getenv('DB_PASSWORD', 'postgres'),
}

# Constants
SELLER_TIN = '0021164165056000'
SELLER_IDTKU = '0021164165056000000000'
TAX_INVOICE_OPT = 'Normal'
VAT_RATE = Decimal('12')


def get_db_connection():
    """Create and return a database connection."""
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        return conn
    except Exception as e:
        logger.error(f"Failed to connect to database: {e}")
        sys.exit(1)


def get_invoices_to_process(
    conn,
    batch_id: Optional[str] = None,
    invoice_number: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    Get unique (invoice, buyer_party_id) groups from temporaryStaging.
    Skip groups that already exist in tax_invoices.

    Args:
        conn: Database connection
        batch_id: Optional filter by batch_id
        invoice_number: Optional filter by specific invoice

    Returns:
        List of dict with keys: invoice, buyer_party_id, ship_date, count
    """
    where_clauses = []
    params = []

    if batch_id:
        where_clauses.append("ts.batch_id = %s")
        params.append(batch_id)

    if invoice_number:
        where_clauses.append("ts.invoice = %s")
        params.append(invoice_number)

    where_sql = "WHERE " + " AND ".join(where_clauses) if where_clauses else ""

    query = f"""
    SELECT
        ts.invoice,
        ts.buyer_party_id,
        MIN(ts.ship_date) as ship_date,
        COUNT(*) as item_count
    FROM public."temporaryStaging" ts
    {where_sql}
    GROUP BY ts.invoice, ts.buyer_party_id
    HAVING NOT EXISTS (
        SELECT 1 FROM tax_invoices ti
        WHERE ti.invoice_number = ts.invoice
          AND ti.buyer_party_id = ts.buyer_party_id
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
        buyer_idtku
    FROM public.parties
    WHERE id = %s AND deleted_at IS NULL
    """

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(query, (buyer_party_id,))
        return cur.fetchone()


def fetch_staging_items(
    conn,
    invoice_number: str,
    buyer_party_id: str
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
        batch_id
    FROM public."temporaryStaging"
    WHERE invoice = %s AND buyer_party_id = %s
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
    upsert_query = """
    INSERT INTO tax_invoices (
        batch_id,
        invoice_number,
        buyer_party_id,
        tin,
        tax_invoice_date,
        tax_invoice_opt,
        trx_code,
        ref_desc,
        seller_idtku,
        buyer_tin,
        buyer_document,
        buyer_country,
        buyer_name,
        buyer_address,
        buyer_email,
        buyer_idtku
    ) VALUES (
        %(batch_id)s,
        %(invoice_number)s,
        %(buyer_party_id)s,
        %(tin)s,
        %(tax_invoice_date)s,
        %(tax_invoice_opt)s,
        %(trx_code)s,
        %(ref_desc)s,
        %(seller_idtku)s,
        %(buyer_tin)s,
        %(buyer_document)s,
        %(buyer_country)s,
        %(buyer_name)s,
        %(buyer_address)s,
        %(buyer_email)s,
        %(buyer_idtku)s
    )
    ON CONFLICT (invoice_number, buyer_party_id)
    DO UPDATE SET
        tax_invoice_date = EXCLUDED.tax_invoice_date,
        trx_code = EXCLUDED.trx_code,
        buyer_tin = EXCLUDED.buyer_tin,
        buyer_country = EXCLUDED.buyer_country,
        buyer_name = EXCLUDED.buyer_name,
        buyer_address = EXCLUDED.buyer_address,
        buyer_email = EXCLUDED.buyer_email,
        buyer_idtku = EXCLUDED.buyer_idtku,
        updated_at = CURRENT_TIMESTAMP
    RETURNING id
    """

    if dry_run:
        logger.info(f"[DRY RUN] Would UPSERT tax_invoice: {invoice_data['invoice_number']}")
        return None

    with conn.cursor() as cur:
        cur.execute(upsert_query, invoice_data)
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


def process_invoice_group(
    conn,
    invoice_number: str,
    buyer_party_id: str,
    ship_date: str,
    dry_run: bool = False
) -> bool:
    """
    Process one (invoice, buyer_party_id) group.

    Steps:
    1. Fetch buyer party details
    2. Fetch staging items
    3. Validate and resolve HS codes and UOMs
    4. UPSERT tax_invoice
    5. Delete existing items (if not dry_run)
    6. Insert new tax_invoice_items

    Args:
        conn: Database connection
        invoice_number: Invoice number
        buyer_party_id: Buyer party UUID
        ship_date: Invoice date
        dry_run: If True, log but don't commit

    Returns:
        True if successful, False otherwise
    """
    logger.info(f"Processing invoice: {invoice_number}, buyer: {buyer_party_id}")

    try:
        # 1. Fetch buyer party
        buyer = fetch_buyer_party(conn, buyer_party_id)
        if not buyer:
            logger.error(f"Buyer party not found: {buyer_party_id}")
            return False

        # 2. Fetch staging items
        staging_items = fetch_staging_items(conn, invoice_number, buyer_party_id)
        if not staging_items:
            logger.warning(f"No staging items found for invoice: {invoice_number}")
            return False

        logger.info(f"  Found {len(staging_items)} items")

        # 3. Prepare invoice header data
        buyer_name = buyer['name_normalized'] or buyer['display_name']
        invoice_data = {
            'batch_id': staging_items[0]['batch_id'],
            'invoice_number': invoice_number,
            'buyer_party_id': buyer_party_id,
            'tin': SELLER_TIN,
            'tax_invoice_date': ship_date,
            'tax_invoice_opt': TAX_INVOICE_OPT,
            'trx_code': buyer['transaction_code'],
            'ref_desc': invoice_number,  # Same as invoice_number
            'seller_idtku': SELLER_IDTKU,
            'buyer_tin': buyer['tin_normalized'],
            'buyer_document': 'TIN',
            'buyer_country': buyer['country_code'],
            'buyer_name': buyer_name,
            'buyer_address': buyer['address_full'],
            'buyer_email': buyer['email'],
            'buyer_idtku': buyer['buyer_idtku'],
        }

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

        for idx, staging_item in enumerate(staging_items, start=1):
            # Parse and validate HS code
            opt, code = parse_hs_code(staging_item['hs_code'])
            if not code:
                error_msg = f"  ⚠️  Invalid HS code: {staging_item['hs_code']} (row {staging_item['id']})"
                logger.warning(error_msg)
                errors.append(error_msg)
                continue

            if not dry_run and not validate_hs_code(code, conn):
                error_msg = f"  ⚠️  HS code not found in hs_codes table: {code} (row {staging_item['id']})"
                logger.warning(error_msg)
                errors.append(error_msg)
                # Continue anyway for now, but log the error

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
            calculations = compute_item_calculations(price, qty)

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
                'vat_rate': VAT_RATE,
                'vat': calculations['vat'],
            }

            items_data.append(item_data)

        # 6. Delete existing items and insert new ones
        if not dry_run:
            delete_existing_items(conn, tax_invoice_id)

        inserted_count = insert_tax_invoice_items(conn, tax_invoice_id, items_data, dry_run)

        logger.info(f"  ✓ Processed {inserted_count} items")
        if errors:
            logger.warning(f"  ⚠️  {len(errors)} errors/warnings during processing")

        return True

    except Exception as e:
        logger.error(f"Error processing invoice {invoice_number}: {e}")
        import traceback
        traceback.print_exc()
        return False


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description='Build normalized invoices from temporaryStaging'
    )
    parser.add_argument(
        '--batch-id',
        help='Process specific batch UUID'
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

    if not args.batch_id and not args.invoice:
        logger.error("Error: Must specify either --batch-id or --invoice")
        sys.exit(1)

    logger.info("=" * 70)
    logger.info("  INVOICE NORMALIZATION (s03)")
    logger.info("=" * 70)
    if args.dry_run:
        logger.info("  MODE: DRY RUN (no changes will be committed)")
    logger.info("")

    # Connect to database
    conn = get_db_connection()
    conn.autocommit = False  # Use transactions

    try:
        # Get invoices to process
        invoices = get_invoices_to_process(conn, args.batch_id, args.invoice)

        if not invoices:
            logger.info("No invoices to process (all may already exist in tax_invoices)")
            return

        logger.info(f"Found {len(invoices)} invoice groups to process")
        logger.info("")

        # Process each invoice group
        success_count = 0
        error_count = 0

        for inv in invoices:
            success = process_invoice_group(
                conn,
                inv['invoice'],
                inv['buyer_party_id'],
                inv['ship_date'],
                args.dry_run
            )

            if success:
                success_count += 1
            else:
                error_count += 1

        # Commit if not dry-run
        if not args.dry_run:
            conn.commit()
            logger.info("")
            logger.info("✓ Transaction committed")
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
        logger.info("=" * 70)

    except Exception as e:
        conn.rollback()
        logger.error(f"Fatal error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
