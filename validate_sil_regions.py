#!/usr/bin/env python3
"""
Validate Silesia segmenter regions by extracting and displaying the captured text.
This script reads existing s02.json and s03.json files and shows what each region captures.
"""

import json
import sys
from pathlib import Path
from typing import Dict, List, Any, Tuple

def extract_tokens_in_region(tokens: List[Dict], region_bbox: Dict, tolerance: float = 0.001) -> List[Dict]:
    """Extract tokens that fall within a region's bounding box."""
    region_tokens = []

    rx0, ry0, rx1, ry1 = region_bbox['x0'], region_bbox['y0'], region_bbox['x1'], region_bbox['y1']

    for token in tokens:
        bbox = token.get('bbox', {})
        tx0, ty0, tx1, ty1 = bbox.get('x0', 0), bbox.get('y0', 0), bbox.get('x1', 0), bbox.get('y1', 0)

        # Check if token center is within region
        token_cx = (tx0 + tx1) / 2
        token_cy = (ty0 + ty1) / 2

        if (rx0 - tolerance <= token_cx <= rx1 + tolerance and
            ry0 - tolerance <= token_cy <= ry1 + tolerance):
            region_tokens.append(token)

    return region_tokens

def format_tokens_as_text(tokens: List[Dict], y_tolerance: float = 0.01) -> str:
    """Format tokens as text, grouping by lines."""
    if not tokens:
        return "(empty)"

    # Sort tokens by position (top to bottom, left to right)
    sorted_tokens = sorted(tokens, key=lambda t: (t['bbox']['y0'], t['bbox']['x0']))

    # Group into lines
    lines = []
    current_line = []
    last_y = None

    for token in sorted_tokens:
        y = token['bbox']['y0']

        if last_y is None or abs(y - last_y) < y_tolerance:
            current_line.append(token)
        else:
            if current_line:
                # Sort current line left to right
                current_line.sort(key=lambda t: t['bbox']['x0'])
                line_text = ' '.join(t.get('text', '') for t in current_line)
                lines.append(line_text)
            current_line = [token]

        last_y = y

    # Don't forget the last line
    if current_line:
        current_line.sort(key=lambda t: t['bbox']['x0'])
        line_text = ' '.join(t.get('text', '') for t in current_line)
        lines.append(line_text)

    return '\n'.join(lines)

def validate_variant(variant: int, engine: str = 'pymupdf') -> Dict[str, str]:
    """Validate a single variant and return extracted text for each region."""
    base_path = Path(f'services/pdf2json/training/sil/{variant}')

    s02_path = base_path / 's02.json'
    s03_path = base_path / 's03.json'

    if not s02_path.exists() or not s03_path.exists():
        return {"error": f"Files not found for variant {variant}"}

    with open(s02_path) as f:
        s02_data = json.load(f)

    with open(s03_path) as f:
        s03_data = json.load(f)

    # Get tokens for the specified engine
    if engine not in s02_data:
        return {"error": f"Engine '{engine}' not found in s02 data"}

    tokens = s02_data[engine].get('tokens', [])

    # Extract text for each region
    results = {}
    target_regions = ['subtotal', 'tax_based', 'vat', 'grand_total']

    for region_def in s03_data.get('regions', []):
        region_id = region_def.get('id')

        if region_id in target_regions:
            region_bbox = region_def.get('bbox')
            if region_bbox:
                region_tokens = extract_tokens_in_region(tokens, region_bbox)
                text = format_tokens_as_text(region_tokens)
                results[region_id] = text
            else:
                results[region_id] = "(no bbox)"

    return results

def main():
    """Main function to validate all variants."""
    print("=" * 70)
    print("Silesia Segmenter Region Validation")
    print("=" * 70)
    print()

    # Expected outputs for comparison
    expected = {
        1: {
            "subtotal": "Items total:\n129.508.650,00",
            "tax_based": "\nTax Based:\n118.716.262,50",
            "vat": "VAT:\n12 118.716.262,50\n11,000 %\n129.508.650,00 14.245.951,50",
            "grand_total": "Final invoice amount: IDR 143.754.601,50"
        },
        2: {
            "subtotal": "Items total:\n14.782.880,00",
            "tax_based": "\nTax Based:\n13.550.973,33",
            "vat": "VAT:\n12 13.550.973,33\n14.782.880,00 1.626.116,80",
            "grand_total": "Final invoice amount: IDR 16.408.996,80"
        }
    }

    engine = 'pymupdf'  # Use PYMUPDF as mentioned in requirements

    for variant in range(1, 11):
        print(f"\n{'='*70}")
        print(f"VARIANT {variant}")
        print(f"{'='*70}\n")

        results = validate_variant(variant, engine)

        if 'error' in results:
            print(f"❌ Error: {results['error']}")
            continue

        for region in ['subtotal', 'tax_based', 'vat', 'grand_total']:
            text = results.get(region, "(not found)")

            print(f"{region}:")
            print(f'  """{text}"""')

            # Compare with expected if available
            if variant in expected and region in expected[variant]:
                exp = expected[variant][region]
                if text.strip() == exp.strip():
                    print(f"  ✓ Matches expected output")
                else:
                    print(f"  ⚠ DIFFERS from expected:")
                    print(f'  Expected: """{exp}"""')

            print()

    print(f"\n{'='*70}")
    print("Validation Complete")
    print(f"{'='*70}\n")

if __name__ == '__main__':
    main()
