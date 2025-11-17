#!/usr/bin/env python3
"""
Post-processor to derive unit_price from amount/qty when missing.
Usage: python derive_unit_price.py <s06.json>
"""
import sys
import json
from pathlib import Path
from decimal import Decimal, ROUND_HALF_UP

def derive_unit_price(data):
    """Compute unit_price = amount / qty when unit_price is missing."""
    for item in data.get("items", []):
        if item.get("unit_price") is None:
            qty = item.get("qty")
            amount = item.get("amount")

            if qty is not None and amount is not None and qty != 0:
                try:
                    # Convert to Decimal for precision
                    qty_d = Decimal(str(qty))
                    amount_d = Decimal(str(amount))

                    # Compute unit_price = amount / qty
                    unit_price_d = amount_d / qty_d

                    # Round to 0 decimal places (currency_decimals=0 for IDR)
                    unit_price_d = unit_price_d.quantize(Decimal('1'), rounding=ROUND_HALF_UP)

                    # Convert to int if whole number, else float
                    if unit_price_d == unit_price_d.to_integral_value():
                        item["unit_price"] = int(unit_price_d)
                    else:
                        item["unit_price"] = float(unit_price_d)

                except (ValueError, TypeError, Exception) as e:
                    print(f"Warning: Could not derive unit_price for item {item.get('no')}: {e}", file=sys.stderr)

    return data

def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <s06.json>", file=sys.stderr)
        sys.exit(1)

    input_path = Path(sys.argv[1])
    if not input_path.exists():
        print(f"Error: File not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    # Load JSON
    data = json.loads(input_path.read_text(encoding="utf-8"))

    # Derive unit_price
    data = derive_unit_price(data)

    # Write back
    input_path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Processed: {input_path}", file=sys.stderr)

if __name__ == "__main__":
    main()
