#!/usr/bin/env python3
"""
Legacy wrapper for exporting SQL invoices to XML.

Delegates to the sql2xml service CLI to keep logic in one place.
"""

import sys
from pathlib import Path

# In container: /app/stages/s01_sql2xml.py -> SERVICE_DIR is /app
# On host: services/sql2xml/stages/s01_sql2xml.py -> SERVICE_DIR is services/sql2xml
SERVICE_DIR = Path(__file__).resolve().parent.parent

# Ensure sql2xml CLI is importable
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))

from cli import run_cli  # noqa: E402


if __name__ == "__main__":
    sys.exit(run_cli())
