#!/usr/bin/env python3
"""
Quick test script to extract text from segmented regions
"""
import json
import sys
from pathlib import Path

def extract_region_text(s02_data, s03_data, region_id, engine='pymupdf'):
    """Extract text from a specific region"""
    # Find the region in s03
    region_bbox = None
    for region in s03_data.get('regions', []):
        if region.get('id') == region_id:
            region_bbox = region.get('bbox')
            break

    if not region_bbox:
        return f"Region '{region_id}' not found"

    # Get tokens from s02
    if engine not in s02_data:
        return f"Engine '{engine}' not found in s02 data"

    tokens = s02_data[engine].get('tokens', [])

    # Filter tokens that fall within the region bbox
    region_tokens = []
    for token in tokens:
        token_bbox = token.get('bbox', {})
        # Check if token is within region (simple overlap check)
        if (token_bbox.get('x0', 0) >= region_bbox['x0'] - 0.01 and
            token_bbox.get('x1', 0) <= region_bbox['x1'] + 0.01 and
            token_bbox.get('y0', 0) >= region_bbox['y0'] - 0.01 and
            token_bbox.get('y1', 0) <= region_bbox['y1'] + 0.01):
            region_tokens.append(token)

    # Sort tokens by position (top to bottom, left to right)
    region_tokens.sort(key=lambda t: (t['bbox']['y0'], t['bbox']['x0']))

    # Group tokens into lines based on y-position
    lines = []
    current_line = []
    last_y = None
    y_tolerance = 0.01

    for token in region_tokens:
        y = token['bbox']['y0']
        if last_y is None or abs(y - last_y) < y_tolerance:
            current_line.append(token)
        else:
            if current_line:
                current_line.sort(key=lambda t: t['bbox']['x0'])
                lines.append(' '.join(t.get('text', '') for t in current_line))
            current_line = [token]
        last_y = y

    if current_line:
        current_line.sort(key=lambda t: t['bbox']['x0'])
        lines.append(' '.join(t.get('text', '') for t in current_line))

    return '\n'.join(lines)

def main():
    if len(sys.argv) < 4:
        print("Usage: python test_sil_regions.py <variant> <region_id> <engine>")
        sys.exit(1)

    variant = sys.argv[1]
    region_id = sys.argv[2]
    engine = sys.argv[3] if len(sys.argv) > 3 else 'pymupdf'

    s02_path = Path(f'services/pdf2json/training/sil/{variant}/s02.json')
    s03_path = Path(f'services/pdf2json/training/sil/{variant}/s03.json')

    if not s02_path.exists():
        print(f"Error: {s02_path} not found")
        sys.exit(1)

    if not s03_path.exists():
        print(f"Error: {s03_path} not found")
        sys.exit(1)

    with open(s02_path) as f:
        s02_data = json.load(f)

    with open(s03_path) as f:
        s03_data = json.load(f)

    text = extract_region_text(s02_data, s03_data, region_id, engine)

    print(f"=== Variant {variant} - Region '{region_id}' - Engine '{engine}' ===")
    print(text)
    print()

if __name__ == '__main__':
    main()
