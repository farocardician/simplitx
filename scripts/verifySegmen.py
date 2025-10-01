#!/usr/bin/env python3
"""
Extract and print text contained inside a specific region's bounding box.
"""

import argparse
import json
import sys
import os
import re
from typing import List, Dict, Any, Tuple, Optional


def load_json(path: str) -> Dict[str, Any]:
    """Load JSON file with error handling."""
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"Error: File not found: {path}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON in {path}: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: Failed to read {path}: {e}", file=sys.stderr)
        sys.exit(1)


def bbox_intersects(a: List[float], b: List[float], touch_ok: bool = True) -> bool:
    """Check if two bounding boxes intersect."""
    if len(a) != 4 or len(b) != 4:
        return False

    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b

    if touch_ok:
        return not (ax1 < bx0 or bx1 < ax0 or ay1 < by0 or by1 < ay0)
    else:
        return not (ax1 <= bx0 or bx1 <= ax0 or ay1 <= by0 or by1 <= ay0)


def normalize_bbox(bbox) -> List[float]:
    """Normalize bbox to [x0, y0, x1, y1] list format."""
    if isinstance(bbox, dict):
        return [bbox['x0'], bbox['y0'], bbox['x1'], bbox['y1']]
    elif isinstance(bbox, list) and len(bbox) == 4:
        return bbox
    else:
        return [0.0, 0.0, 0.0, 0.0]


def token_center(bbox) -> Tuple[float, float]:
    """Calculate the center point of a bounding box."""
    bbox_list = normalize_bbox(bbox)
    if len(bbox_list) != 4:
        return (0.0, 0.0)
    x0, y0, x1, y1 = bbox_list
    return ((x0 + x1) / 2, (y0 + y1) / 2)


def iter_tokens_from_s02(obj: Dict[str, Any], tokenizer: Optional[str] = None):
    """Iterator to extract tokens from S02 data, handling different structures and tokenizers."""
    tokenizers_to_try = []

    if tokenizer == 'plumber':
        tokenizers_to_try = ['plumber']
    elif tokenizer == 'pymupdf':
        tokenizers_to_try = ['pymupdf']
    elif tokenizer is None:
        # Try both tokenizers if available
        tokenizers_to_try = ['plumber', 'pymupdf']
    else:
        tokenizers_to_try = [tokenizer]  # Custom tokenizer name

    tokens_found = False

    # Try each tokenizer source
    for tokenizer_name in tokenizers_to_try:
        if tokenizer_name in obj and 'tokens' in obj[tokenizer_name] and isinstance(obj[tokenizer_name]['tokens'], list):
            for token in obj[tokenizer_name]['tokens']:
                tokens_found = True
                # Add tokenizer info to token for later identification
                token_with_source = dict(token)
                token_with_source['_tokenizer_source'] = tokenizer_name
                yield token_with_source

    # Fallback to direct structures if no tokenizer-specific tokens found
    if not tokens_found:
        if 'tokens' in obj and isinstance(obj['tokens'], list):
            # Flat structure: {tokens: [...]}
            for token in obj['tokens']:
                token_with_source = dict(token)
                token_with_source['_tokenizer_source'] = 'unknown'
                yield token_with_source
        elif 'pages' in obj and isinstance(obj['pages'], list):
            # Nested structure: {pages: [{tokens: [...]}, ...]}
            for page in obj['pages']:
                if 'tokens' in page and isinstance(page['tokens'], list):
                    for token in page['tokens']:
                        token_with_source = dict(token)
                        token_with_source['_tokenizer_source'] = 'unknown'
                        yield token_with_source
        elif isinstance(obj, list):
            # Direct list of tokens
            for token in obj:
                token_with_source = dict(token)
                token_with_source['_tokenizer_source'] = 'unknown'
                yield token_with_source


def extract_region_text(s02_data: Dict[str, Any], region_bbox: List[float], region_page: int, tokenizer: Optional[str], row_gap: float, touch_ok: bool) -> Dict[str, List[str]]:
    """Extract text from a specific region and return results grouped by tokenizer."""
    # Collect tokens on the target page that intersect with the region
    matching_tokens = []

    for token in iter_tokens_from_s02(s02_data, tokenizer):
        # Check if token is on the right page
        token_page = token.get('page', 1)
        if token_page != region_page:
            continue

        # Check if token has valid bbox and text
        token_bbox = token.get('bbox')
        token_text = token.get('text', '').strip()

        if not token_bbox or not token_text:
            continue

        # Normalize bbox format
        normalized_bbox = normalize_bbox(token_bbox)
        if not normalized_bbox or len(normalized_bbox) != 4:
            continue

        # Check if token bbox intersects with region bbox
        if bbox_intersects(normalized_bbox, region_bbox, touch_ok):
            matching_tokens.append(token)

    # Group tokens by tokenizer source if no specific tokenizer chosen
    if tokenizer is None:
        tokenizer_groups = {}
        for token in matching_tokens:
            source = token.get('_tokenizer_source', 'unknown')
            if source not in tokenizer_groups:
                tokenizer_groups[source] = []
            tokenizer_groups[source].append(token)

        result = {}
        for tokenizer_name in ['plumber', 'pymupdf', 'unknown']:
            if tokenizer_name in tokenizer_groups:
                result[tokenizer_name] = reconstruct_lines(tokenizer_groups[tokenizer_name], row_gap)
        return result
    else:
        # Single tokenizer
        return {tokenizer: reconstruct_lines(matching_tokens, row_gap)}


def normalize_text(text: str) -> str:
    """
    Normalize text using the specified rules:
    - Lowercase
    - Replace [.,:;()\-\/] with spaces
    - Collapse multiple spaces to one; trim
    """
    # Lowercase
    text = text.lower()
    # Replace [.,:;()\-\/] with spaces
    text = re.sub(r'[.,:;()\-\/]', ' ', text)
    # Collapse multiple spaces to one; trim
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def reconstruct_lines(tokens: List[Dict[str, Any]], row_gap: float) -> List[str]:
    """Group tokens into lines and reconstruct text."""
    if not tokens:
        return []

    # Sort tokens by (y_center, x_center)
    def sort_key(token):
        bbox = token.get('bbox', [0, 0, 0, 0])
        cx, cy = token_center(bbox)
        return (cy, cx)

    sorted_tokens = sorted(tokens, key=sort_key)

    # Group tokens into lines based on row_gap
    lines = []
    current_line = []
    last_y = None

    for token in sorted_tokens:
        bbox = token.get('bbox', [0, 0, 0, 0])
        _, cy = token_center(bbox)

        if last_y is None or abs(cy - last_y) <= row_gap:
            # Same line
            current_line.append(token)
        else:
            # New line
            if current_line:
                lines.append(current_line)
            current_line = [token]

        last_y = cy

    # Don't forget the last line
    if current_line:
        lines.append(current_line)

    # Sort tokens within each line by x position and reconstruct text
    result = []
    for line in lines:
        # Sort tokens in line by x_center
        line.sort(key=lambda t: token_center(t.get('bbox', [0, 0, 0, 0]))[0])

        # Join token texts with single space
        texts = [token.get('text', '').strip() for token in line]
        texts = [t for t in texts if t]  # Remove empty strings

        if texts:
            line_text = ' '.join(texts)
            # Collapse multiple spaces and strip
            line_text = re.sub(r'\s+', ' ', line_text).strip()
            if line_text:
                result.append(line_text)

    return result


def main():
    parser = argparse.ArgumentParser(
        description="Extract text from a specific region's bounding box"
    )
    parser.add_argument('--token', required=True,
                       help='Path to S02 tokens JSON file')
    parser.add_argument('--segmen', required=True,
                       help='Path to S03 segments JSON file')
    parser.add_argument('--region-id',
                       help='Region ID to extract text from. If not specified, extracts all available regions.')
    parser.add_argument('--row-gap', type=float, default=0.006,
                       help='Line grouping threshold (default: 0.006)')
    parser.add_argument('--touch-ok', action='store_true', default=True,
                       help='Count edge-touching tokens as inside (default: True)')
    parser.add_argument('--no-touch-ok', dest='touch_ok', action='store_false',
                       help='Do not count edge-touching tokens as inside')
    parser.add_argument('--lines', action='store_true',
                       help='Print one line per row (default)')
    parser.add_argument('--text', action='store_true',
                       help='Print as a single paragraph')
    parser.add_argument('--tokenizer', choices=['plumber', 'pymupdf'],
                       help='Specify tokenizer source (plumber or pymupdf). If not specified, tries both.')
    parser.add_argument('--normalized', action='store_true',
                       help='Show normalized text alongside original text')
    parser.add_argument('--check-coverage',
                       help='Check if provided text is fully covered by the region. Can be a file path or multiline string.')

    args = parser.parse_args()

    # Default to --lines if neither --lines nor --text is specified
    if not args.lines and not args.text:
        args.lines = True

    # Load S03 segments
    s03_data = load_json(args.segmen)
    segments = s03_data.get('segments', [])

    # Load S02 tokens
    s02_data = load_json(args.token)

    if args.region_id:
        # Extract specific region
        target_segment = None
        for segment in segments:
            if segment.get('id') == args.region_id:
                target_segment = segment
                break

        if target_segment is None:
            print(f"Region '{args.region_id}' not found in {args.segmen}", file=sys.stderr)
            sys.exit(2)

        # Get region bbox and page
        region_bbox = target_segment.get('bbox')
        if not region_bbox or len(region_bbox) != 4:
            print(f"Region '{args.region_id}' has no valid bbox", file=sys.stderr)
            sys.exit(2)

        region_page = target_segment.get('page', 1)

        # Extract text for this region
        tokenizer_results = extract_region_text(s02_data, region_bbox, region_page, args.tokenizer, args.row_gap, args.touch_ok)

        # Output results
        if args.tokenizer is None and len(tokenizer_results) > 1:
            # Multiple tokenizers - show with headers
            first_group = True
            for tokenizer_name in ['plumber', 'pymupdf', 'unknown']:
                if tokenizer_name in tokenizer_results:
                    if not first_group:
                        print()  # Blank line between groups
                    print(f"=== {tokenizer_name.upper()} ====")
                    lines = tokenizer_results[tokenizer_name]
                    if args.text:
                        if lines:
                            print(' '.join(lines))
                            if args.normalized:
                                print(f"NORMALIZED: {normalize_text(' '.join(lines))}")
                    else:
                        for line in lines:
                            print(line)
                            if args.normalized:
                                print(f"  -> {normalize_text(line)}")
                    first_group = False
        else:
            # Single tokenizer - output normally
            for tokenizer_name, lines in tokenizer_results.items():
                if args.text:
                    if lines:
                        print(' '.join(lines))
                        if args.normalized:
                            print(f"NORMALIZED: {normalize_text(' '.join(lines))}")
                else:
                    for line in lines:
                        print(line)
                        if args.normalized:
                            print(f"  -> {normalize_text(line)}")
                break  # Only one result expected

        # Check coverage if requested
        if args.check_coverage:
            print("\n" + "="*50)
            print("COVERAGE CHECK")
            print("="*50)

            # Get all lines from the first (or only) tokenizer result
            all_extracted_lines = []
            for tokenizer_name, lines in tokenizer_results.items():
                all_extracted_lines = lines
                break

            # Normalize all extracted text into one joined string
            all_extracted_normalized = normalize_text(' '.join(all_extracted_lines))
            print(f"EXTRACTED (normalized): {all_extracted_normalized}")

            # Determine if check_coverage is a file path or direct text
            required_text = args.check_coverage.strip()
            if os.path.isfile(required_text):
                print(f"Reading required text from file: {required_text}")
                try:
                    with open(required_text, 'r', encoding='utf-8') as f:
                        required_text = f.read()
                except Exception as e:
                    print(f"Error reading file {required_text}: {e}", file=sys.stderr)
                    sys.exit(1)
            else:
                print("Using provided text directly")

            # Parse required text lines
            required_lines = [line.strip() for line in required_text.strip().split('\n') if line.strip()]
            required_normalized_lines = []
            for line in required_lines:
                normalized = normalize_text(line)
                if normalized:
                    required_normalized_lines.append(normalized)

            print(f"\nREQUIRED TEXT ({len(required_normalized_lines)} lines):")
            for i, line in enumerate(required_normalized_lines, 1):
                print(f"  {i}. {line}")

            print(f"\nCHECKING COVERAGE:")
            missing_count = 0
            for i, line in enumerate(required_normalized_lines, 1):
                if line in all_extracted_normalized:
                    print(f"  ✓ [{i}] FOUND: '{line}'")
                else:
                    print(f"  ✗ [{i}] MISSING: '{line}'")
                    missing_count += 1

            print(f"\n" + "="*50)
            print(f"COVERAGE SUMMARY")
            print(f"="*50)
            print(f"Total required lines: {len(required_normalized_lines)}")
            print(f"Missing lines: {missing_count}")
            coverage_pct = ((len(required_normalized_lines) - missing_count) / len(required_normalized_lines)) * 100 if required_normalized_lines else 0
            print(f"Coverage: {coverage_pct:.1f}%")

            if missing_count == 0:
                print("\n🎉 SUCCESS: ALL REQUIRED TEXT IS CAPTURED!")
            else:
                print(f"\n❌ FAILURE: {missing_count} lines still missing")
    else:
        # Extract all available regions
        if not segments:
            print("No segments found in the S03 file", file=sys.stderr)
            sys.exit(1)

        print(f"Found {len(segments)} available regions:\n")

        for i, segment in enumerate(segments):
            region_id = segment.get('id', 'unknown')
            region_bbox = segment.get('bbox')
            region_page = segment.get('page', 1)

            if not region_bbox or len(region_bbox) != 4:
                print(f"[{i+1}] Region '{region_id}' - INVALID BBOX")
                continue

            print(f"[{i+1}] Region: {region_id} (Page {region_page})")
            print(f"    Bbox: {region_bbox}")

            # Extract text for this region
            tokenizer_results = extract_region_text(s02_data, region_bbox, region_page, args.tokenizer, args.row_gap, args.touch_ok)

            if args.tokenizer is None and len(tokenizer_results) > 1:
                # Multiple tokenizers - show with headers
                for tokenizer_name in ['plumber', 'pymupdf', 'unknown']:
                    if tokenizer_name in tokenizer_results:
                        lines = tokenizer_results[tokenizer_name]
                        if lines:
                            print(f"    === {tokenizer_name.upper()} ====")
                            if args.text:
                                print(f"    {' '.join(lines)}")
                            else:
                                for line in lines:
                                    print(f"    {line}")
            else:
                # Single tokenizer
                for tokenizer_name, lines in tokenizer_results.items():
                    if lines:
                        if args.text:
                            print(f"    {' '.join(lines)}")
                        else:
                            for line in lines:
                                print(f"    {line}")
                    break

            if i < len(segments) - 1:
                print()  # Blank line between regions

    sys.exit(0)


if __name__ == '__main__':
    main()