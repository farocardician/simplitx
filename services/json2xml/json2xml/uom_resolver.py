"""UOM (Unit of Measure) resolver for json2xml conversion."""

import os
from typing import Optional, Dict


def resolve_uom(uom_name: str) -> Optional[str]:
    """
    Resolve UOM name/alias to canonical code via web service API.

    Args:
        uom_name: UOM name or alias (e.g., "KG", "PIECE", "pcs")

    Returns:
        Canonical UOM code (e.g., "UM.0003") or None if unresolved
    """
    if not uom_name:
        return None

    try:
        import httpx
    except ImportError:
        # If httpx not available, return original
        return None

    web_service_url = os.getenv("WEB_SERVICE_URL")
    if not web_service_url:
        # No web service URL configured
        return None

    try:
        # Call web service UOM resolve API
        with httpx.Client(timeout=5.0) as client:
            response = client.post(
                f"{web_service_url}/api/uom/resolve",
                json={"aliases": [uom_name]}
            )
            response.raise_for_status()
            data = response.json()

            # Extract resolved code from response
            if data.get("results"):
                for result in data["results"]:
                    if result["input"] == uom_name and result.get("resolved"):
                        return result["resolved"]["code"]

        return None

    except Exception as e:
        # Log warning but don't fail conversion
        print(f"Warning: UOM resolution failed for '{uom_name}': {e}")
        return None
