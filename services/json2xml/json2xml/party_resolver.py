"""
Party resolution for buyer data lookup.
Ports logic from web service lib/partyResolver.ts to Python.
"""

import json
import os
import re
from pathlib import Path
from typing import Optional, Dict, Any
from Levenshtein import ratio as dice_coefficient

# Database connection
_db_connection = None
_party_thresholds = None


def get_db_connection():
    """Get or create database connection."""
    global _db_connection

    if _db_connection is None:
        database_url = os.getenv("DATABASE_URL")
        if not database_url:
            raise RuntimeError("DATABASE_URL environment variable not set")

        import psycopg
        _db_connection = psycopg.connect(database_url, autocommit=True)

    return _db_connection


def normalize_party_name(display_name: str) -> str:
    """
    Normalize party name for deterministic lookups.
    Must match normalize_party_name() database function exactly.
    """
    normalized = display_name.strip()
    normalized = normalized.upper()
    normalized = re.sub(r'[,.\'""]', '', normalized)  # Strip punctuation
    normalized = re.sub(r'\s+', ' ', normalized)      # Collapse spaces
    normalized = re.sub(r'-+', '-', normalized)       # Collapse hyphens
    normalized = normalized.strip()
    return normalized


def resolve_buyer_party(buyer_name: str) -> Optional[Dict[str, Any]]:
    """
    Resolve buyer party using exact-then-fuzzy matching.
    Returns party data or None if unresolved.

    For json2xml, we use a simplified version that:
    - Returns exact match immediately (confidence 1.0)
    - Returns high-confidence fuzzy match (≥0.92) if no close ties
    - Returns None otherwise (requires manual resolution)
    """
    if not buyer_name or not buyer_name.strip():
        return None

    normalized = normalize_party_name(buyer_name)
    thresholds = get_party_thresholds()
    conn = get_db_connection()

    # STAGE 1: Exact match on name_normalized
    with conn.cursor() as cur:
        cur.execute("""
            SELECT
                id, display_name, name_normalized, tin_display, tin_normalized,
                country_code, address_full, email, buyer_document,
                buyer_document_number, buyer_idtku
            FROM parties
            WHERE name_normalized = %s AND deleted_at IS NULL
        """, (normalized,))

        exact_matches = cur.fetchall()

    # Data integrity check
    if len(exact_matches) > 1:
        # Multiple exact matches - data error, return None (requires admin cleanup)
        return None

    if len(exact_matches) == 1:
        # Exact match found
        row = exact_matches[0]
        return {
            'id': row[0],
            'displayName': row[1],
            'nameNormalized': row[2],
            'tinDisplay': row[3],
            'tinNormalized': row[4],
            'countryCode': row[5],
            'addressFull': row[6],
            'email': row[7],
            'buyerDocument': row[8],
            'buyerDocumentNumber': row[9],
            'buyerIdtku': row[10],
            'confidence': 1.0
        }

    # STAGE 2: Fuzzy matching
    with conn.cursor() as cur:
        cur.execute("""
            SELECT
                id, display_name, name_normalized, tin_display, tin_normalized,
                country_code, address_full, email, buyer_document,
                buyer_document_number, buyer_idtku
            FROM parties
            WHERE deleted_at IS NULL
        """)

        all_parties = cur.fetchall()

    if not all_parties:
        return None

    # Compute fuzzy scores using Dice coefficient
    confidence_auto_select = thresholds["confidenceAutoSelect"]
    tie_proximity_threshold = thresholds["tieProximityThreshold"]

    scored = []
    for row in all_parties:
        party_normalized = row[2]
        score = dice_coefficient(normalized, party_normalized)

        if score >= confidence_auto_select:
            scored.append({
                'id': row[0],
                'displayName': row[1],
                'nameNormalized': row[2],
                'tinDisplay': row[3],
                'tinNormalized': row[4],
                'countryCode': row[5],
                'addressFull': row[6],
                'email': row[7],
                'buyerDocument': row[8],
                'buyerDocumentNumber': row[9],
                'buyerIdtku': row[10],
                'score': score,
                'confidence': score
            })

    if not scored:
        # No high-confidence matches - return None (requires manual resolution)
        return None

    # Sort by score descending
    scored.sort(key=lambda x: x['score'], reverse=True)

    top_candidate = scored[0]
    top_score = top_candidate['score']

    # Check for close ties
    close_ties = [c for c in scored if abs(c['score'] - top_score) <= tie_proximity_threshold]

    if len(close_ties) > 1:
        # Multiple candidates within tie threshold - return None (requires manual resolution)
        return None

    # Single high-confidence match - return it
    return top_candidate


def get_buyer_field(buyer_name: str, field_name: str) -> str:
    """
    Get a specific field from resolved buyer party.
    Returns empty string if buyer cannot be resolved or field is null.

    Supported fields:
    - tin: TIN display value
    - country: Country code
    - address: Full address
    - email: Email address
    - document_type: Buyer document type (TIN/PASSPORT/etc)
    - document_number: Buyer document number
    - idtku: Buyer IDTKU
    """
    party = resolve_buyer_party(buyer_name)

    if not party:
        return ""

    field_map = {
        'tin': 'tinDisplay',
        'country': 'countryCode',
        'address': 'addressFull',
        'email': 'email',
        'document_type': 'buyerDocument',
        'document_number': 'buyerDocumentNumber',
        'idtku': 'buyerIdtku'
    }

    key = field_map.get(field_name)
    if not key:
        return ""

    value = party.get(key)
    if value is None:
        return ""

    return str(value)
def get_party_thresholds() -> Dict[str, Any]:
    """Load shared party resolution thresholds from JSON once."""
    global _party_thresholds

    if _party_thresholds is None:
        config_path = Path(__file__).resolve().parents[2] / 'shared' / 'partyThresholds.json'
        try:
            with config_path.open('r', encoding='utf-8') as handle:
                _party_thresholds = json.load(handle)
        except FileNotFoundError as exc:
            raise RuntimeError(f"Party threshold config not found at {config_path}") from exc
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Party threshold config is invalid JSON: {exc}") from exc

    return _party_thresholds
