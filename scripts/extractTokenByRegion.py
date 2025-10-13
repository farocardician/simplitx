#!/usr/bin/env python3
"""
Token Filter by Bounding Box

This script filters tokens from PDF extraction results (s02.json) based on
segmented regions (s03.json) using bounding box containment logic.

Usage:
    python filter_tokens_by_bbox.py --token s02.json --segment s03.json --region table
    python filter_tokens_by_bbox.py --token s02.json --segment s03.json --region table --tokenizer plumber
    python filter_tokens_by_bbox.py --token s02.json --segment s03.json --region table --out custom_output.json
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Any, Optional, Union

# Small epsilon for tolerant containment checks
EPS = 1e-6


def load_json(file_path: str) -> Dict[str, Any]:
    """
    Load JSON file safely with error handling.

    Args:
        file_path: Path to JSON file

    Returns:
        Parsed JSON data as dictionary

    Raises:
        FileNotFoundError: If file doesn't exist
        json.JSONDecodeError: If file contains invalid JSON
        ValueError: If file is empty or invalid
    """
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        if not data:
            raise ValueError(f"File {file_path} is empty or invalid")

        return data

    except FileNotFoundError:
        raise FileNotFoundError(f"File not found: {file_path}")
    except json.JSONDecodeError as e:
        raise json.JSONDecodeError(f"Invalid JSON in {file_path}: {e.msg}", e.doc, e.pos)


def bbox_fully_inside(inner: Dict[str, float], outer: List[float]) -> bool:
    """
    Check if inner bounding box is fully contained within outer bounding box.
    Uses small epsilon for tolerant containment to avoid dropping boundary tokens.

    Args:
        inner: Inner bbox as dict with 'x0', 'y0', 'x1', 'y1'
        outer: Outer bbox as list [x0, y0, x1, y1]

    Returns:
        True if inner is fully inside outer (with epsilon tolerance), False otherwise
    """
    return (inner['x0'] >= outer[0] - EPS and
            inner['y0'] >= outer[1] - EPS and
            inner['x1'] <= outer[2] + EPS and
            inner['y1'] <= outer[3] + EPS)


def line_inside_region(line: Dict[str, Any], region_bbox: List[float]) -> bool:
    """
    Check if a line is inside a region.

    Args:
        line: Line dictionary with position info
        region_bbox: Region bounding box as [x0, y0, x1, y1]

    Returns:
        True if line is inside region, False otherwise
    """
    # If line has bbox, use full containment
    if 'bbox' in line and isinstance(line['bbox'], dict):
        return bbox_fully_inside(line['bbox'], region_bbox)

    # Else fall back to vertical containment (y0 within region y-interval)
    if 'y0' in line:
        return region_bbox[1] <= line['y0'] <= region_bbox[3]

    # If neither bbox nor y0 available, cannot determine containment
    return False


def get_token_key(token: Dict[str, Any]) -> tuple:
    """
    Get a unique key for a token to identify duplicates.

    Args:
        token: Token dictionary

    Returns:
        Tuple that uniquely identifies the token
    """
    if 'uid' in token:
        return ('uid', token['uid'])

    # Fallback to position and text
    return (
        token.get('page', 0),
        token.get('x0', 0),
        token.get('y0', 0),
        token.get('x1', 0),
        token.get('y1', 0),
        token.get('text', '')
    )


def get_line_key(line: Dict[str, Any]) -> tuple:
    """
    Get a unique key for a line to identify duplicates.

    Args:
        line: Line dictionary

    Returns:
        Tuple that uniquely identifies the line
    """
    # Prefer full bbox + text for uniqueness
    if 'bbox' in line and isinstance(line['bbox'], dict):
        bbox = line['bbox']
        return (
            line.get('page', 0),
            bbox.get('y0', 0),
            bbox.get('y1', bbox.get('y0', 0)),
            line.get('text', '')
        )

    # Fallback to y0 + text
    return (
        line.get('page', 0),
        line.get('y0', 0),
        line.get('text', '')
    )


def filter_tokens_by_bbox(tokens: List[Dict[str, Any]], region_bbox: List[float], page_num: int) -> List[Dict[str, Any]]:
    """
    Filter tokens that are fully contained within a region's bounding box for a specific page.

    Args:
        tokens: List of token dictionaries
        region_bbox: Region bounding box as [x0, y0, x1, y1]
        page_num: Page number to filter for

    Returns:
        List of tokens that are fully inside the region bbox
    """
    filtered_tokens = []

    for token in tokens:
        # Check if token is on the correct page
        if token.get('page') != page_num:
            continue

        # Get token bounding box
        token_bbox = token.get('bbox', {})
        if not token_bbox or not isinstance(token_bbox, dict):
            continue

        # Check containment
        if bbox_fully_inside(token_bbox, region_bbox):
            filtered_tokens.append(token)

    return filtered_tokens


def filter_lines_by_bbox(lines: List[Dict[str, Any]], region_bbox: List[float], page_num: int) -> List[Dict[str, Any]]:
    """
    Filter lines that are inside a region's bounding box for a specific page.

    Args:
        lines: List of line dictionaries
        region_bbox: Region bounding box as [x0, y0, x1, y1]
        page_num: Page number to filter for

    Returns:
        List of lines that are inside the region bbox
    """
    filtered_lines = []

    for line in lines:
        # Check if line is on the correct page
        if line.get('page') != page_num:
            continue

        # Check containment using line_inside_region
        if line_inside_region(line, region_bbox):
            filtered_lines.append(line)

    return filtered_lines


def generate_output_path(token_path: str, region_label: str, tokenizer: Optional[str] = None, custom_out: Optional[str] = None, emit: str = 'both') -> str:
    """
    Generate output file path based on input parameters.

    Args:
        token_path: Path to input s02.json file
        region_label: Region label for filtering
        tokenizer: Tokenizer engine name (pymupdf/plumber) or None for both
        custom_out: Custom output path override
        emit: Output mode - 'both', 'tokens', or 'lines'

    Returns:
        Generated output file path
    """
    if custom_out:
        return custom_out

    # Extract directory and base filename from token path
    token_path_obj = Path(token_path)
    directory = token_path_obj.parent

    # Generate suffix based on emit mode
    suffix = ''
    if emit == 'tokens':
        suffix = '-tokens'
    elif emit == 'lines':
        suffix = '-lines'

    # Generate filename based on tokenizer
    if tokenizer:
        filename = f"s02-{region_label}-{tokenizer}{suffix}.json"
    else:
        filename = f"s02-{region_label}{suffix}.json"

    return str(directory / filename)


def prune_engine_result(engine_result: Dict[str, Any], emit: str) -> Dict[str, Any]:
    """
    Keep only the requested sections of an engine result.
    emit: 'both' | 'tokens' | 'lines'
    """
    if emit == 'tokens':
        # Keep token_count for convenience
        return {
            'token_count': engine_result.get('token_count', len(engine_result.get('tokens', []))),
            'tokens': engine_result.get('tokens', [])
        }
    if emit == 'lines':
        # Optionally expose line_count; skip if you want zero schema change
        return {
            'lines': engine_result.get('lines', [])
            # 'line_count': len(engine_result.get('lines', []))  # uncomment if desired
        }
    return engine_result


def process_engine(engine_name: str, s02_data: Dict[str, Any], s03_data: Dict[str, Any], region_label: str) -> Dict[str, Any]:
    """
    Process tokens for a specific engine (pymupdf or plumber).

    Args:
        engine_name: Name of the engine ('pymupdf' or 'plumber')
        s02_data: Token data from s02.json
        s03_data: Segment data from s03.json
        region_label: Region label to filter for

    Returns:
        Filtered data for the specific engine with tokens and lines
    """
    # Find regions with the specified label
    regions = []
    for segment in s03_data.get('segments', []):
        if segment.get('label') == region_label:
            regions.append(segment)

    if not regions:
        print(f"Warning: No regions found with label '{region_label}'")
        return {'token_count': 0, 'tokens': [], 'lines': []}

    # Get engine-specific data
    engine_data = s02_data.get(engine_name, {})
    tokens = engine_data.get('tokens', [])
    lines = engine_data.get('lines', [])

    # Filter tokens and lines for each region and combine results
    all_filtered_tokens = []
    all_filtered_lines = []

    for region in regions:
        region_bbox = region.get('bbox', [])
        page_num = region.get('page', 1)

        if not region_bbox or len(region_bbox) != 4:
            print(f"Warning: Invalid bbox for region {region.get('id', 'unknown')}")
            continue

        # Filter tokens
        filtered_tokens = filter_tokens_by_bbox(tokens, region_bbox, page_num)
        all_filtered_tokens.extend(filtered_tokens)

        # Filter lines
        filtered_lines = filter_lines_by_bbox(lines, region_bbox, page_num)
        all_filtered_lines.extend(filtered_lines)

    # Remove duplicates using unique keys
    unique_tokens = {}
    for token in all_filtered_tokens:
        token_key = get_token_key(token)
        if token_key not in unique_tokens:
            unique_tokens[token_key] = token

    unique_lines = {}
    for line in all_filtered_lines:
        line_key = get_line_key(line)
        if line_key not in unique_lines:
            unique_lines[line_key] = line

    return {
        'token_count': len(unique_tokens),
        'tokens': list(unique_tokens.values()),
        'lines': list(unique_lines.values())
    }


def save_json(data: Dict[str, Any], output_path: str) -> None:
    """
    Save data to JSON file with proper formatting.

    Args:
        data: Data to save
        output_path: Path to output file
    """
    try:
        # Create output directory if it doesn't exist
        output_dir = os.path.dirname(output_path)
        if output_dir and not os.path.exists(output_dir):
            os.makedirs(output_dir)

        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

    except Exception as e:
        raise IOError(f"Failed to save JSON to {output_path}: {e}")


def validate_arguments(args: argparse.Namespace) -> None:
    """
    Validate command line arguments.

    Args:
        args: Parsed command line arguments

    Raises:
        ValueError: If arguments are invalid
    """
    # Check if required files exist
    if not os.path.exists(args.token):
        raise ValueError(f"Token file does not exist: {args.token}")

    if not os.path.exists(args.segment):
        raise ValueError(f"Segment file does not exist: {args.segment}")

    # Validate tokenizer argument
    if args.tokenizer and args.tokenizer not in ['pymupdf', 'plumber']:
        raise ValueError(f"Invalid tokenizer: {args.tokenizer}. Must be 'pymupdf', 'plumber', or omitted")

    # Check if output directory exists (for custom output path)
    if args.out:
        output_dir = os.path.dirname(args.out)
        if output_dir and not os.path.exists(output_dir):
            raise ValueError(f"Output directory does not exist: {output_dir}")


def main() -> None:
    """Main function to orchestrate the token filtering process."""
    parser = argparse.ArgumentParser(
        description='Filter tokens from PDF extraction results based on segmented regions',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --token s02.json --segment s03.json --region table
  %(prog)s --token s02.json --segment s03.json --region table --tokenizer plumber
  %(prog)s --token s02.json --segment s03.json --region table --out filtered_tokens.json
  %(prog)s --token s02.json --segment s03.json --region table --only-tokens
  %(prog)s --token s02.json --segment s03.json --region table --only-lines
        """
    )

    # Add arguments
    parser.add_argument('--token', '--TOKEN', required=True,
                       help='Path to s02.json file (tokenized PDF data)')
    parser.add_argument('--segment', '--SEGMENT', required=True,
                       help='Path to s03.json file (segmented regions)')
    parser.add_argument('--region', '--REGION', required=True,
                       help='Region label to filter for (e.g., table, header, total)')
    parser.add_argument('--tokenizer', '--TOKENIZER', choices=['pymupdf', 'plumber'],
                       help='Tokenizer engine to process (pymupdf or plumber). If omitted, processes both engines')
    parser.add_argument('--out', '--OUT',
                       help='Custom output path override. If omitted, uses default naming convention')

    # Add mutually exclusive group for tokens/lines filtering
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--only-tokens', action='store_true',
                       help='Emit only tokens in engine results')
    group.add_argument('--only-lines', action='store_true',
                       help='Emit only lines in engine results')

    # Parse arguments
    args = parser.parse_args()

    # Normalize emit mode
    emit = 'tokens' if args.only_tokens else 'lines' if args.only_lines else 'both'

    try:
        # Validate arguments
        validate_arguments(args)

        # Load input files
        print(f"Loading token data from: {args.token}")
        s02_data = load_json(args.token)

        print(f"Loading segment data from: {args.segment}")
        s03_data = load_json(args.segment)

        # Build base result structure with metadata
        result = {
            'doc_id': s02_data.get('doc_id', ''),
            'page_count': s02_data.get('page_count', 0),
            'pages': s02_data.get('pages', []),
            'page_header_band': s02_data.get('page_header_band', [])
        }

        # Generate output path
        output_path = generate_output_path(args.token, args.region, args.tokenizer, args.out, emit)
        output_filename = os.path.basename(output_path)

        if args.tokenizer:
            # Single engine mode
            print(f"Processing {args.tokenizer} engine for region: {args.region}")

            engine_result = process_engine(args.tokenizer, s02_data, s03_data, args.region)
            engine_result = prune_engine_result(engine_result, emit)
            result[args.tokenizer] = engine_result

            # Print summary
            tokens_count = len(engine_result.get('tokens', [])) if emit != 'lines' else None
            lines_count = len(engine_result.get('lines', [])) if emit != 'tokens' else None
            page_num = None
            # Try to get page number from first token or line if available
            if engine_result.get('tokens'):
                page_num = engine_result['tokens'][0].get('page')
            elif engine_result.get('lines'):
                page_num = engine_result['lines'][0].get('page')

            # Build a compact message depending on emit
            if emit == 'tokens':
                msg = f"tokens={tokens_count}"
            elif emit == 'lines':
                msg = f"lines={lines_count}"
            else:
                msg = f"tokens={tokens_count} lines={lines_count}"

            if page_num is not None:
                print(f"[{args.tokenizer}] region={args.region} ...{page_num} {msg} out={output_filename}")
            else:
                print(f"[{args.tokenizer}] region={args.region} {msg} out={output_filename}")

        else:
            # Both engines mode
            print(f"Processing both engines for region: {args.region}")

            # Process each engine independently
            for engine_name in ['pymupdf', 'plumber']:
                if engine_name in s02_data:
                    print(f"Processing {engine_name} engine...")
                    engine_result = process_engine(engine_name, s02_data, s03_data, args.region)
                    engine_result = prune_engine_result(engine_result, emit)
                    result[engine_name] = engine_result

                    # Print summary
                    tokens_count = len(engine_result.get('tokens', [])) if emit != 'lines' else None
                    lines_count = len(engine_result.get('lines', [])) if emit != 'tokens' else None
                    page_num = None
                    # Try to get page number from first token or line if available
                    if engine_result.get('tokens'):
                        page_num = engine_result['tokens'][0].get('page')
                    elif engine_result.get('lines'):
                        page_num = engine_result['lines'][0].get('page')

                    # Build a compact message depending on emit
                    if emit == 'tokens':
                        msg = f"tokens={tokens_count}"
                    elif emit == 'lines':
                        msg = f"lines={lines_count}"
                    else:
                        msg = f"tokens={tokens_count} lines={lines_count}"

                    if page_num is not None:
                        print(f"[{engine_name}] region={args.region} ...{page_num} {msg} out={output_filename}")
                    else:
                        print(f"[{engine_name}] region={args.region} {msg} out={output_filename}")
                else:
                    print(f"Warning: {engine_name} engine not found in s02.json")
                    fallback = {'token_count': 0, 'tokens': [], 'lines': []}
                    result[engine_name] = prune_engine_result(fallback, emit)

                    # Print summary for missing engine
                    if emit == 'tokens':
                        msg = "tokens=0"
                    elif emit == 'lines':
                        msg = "lines=0"
                    else:
                        msg = "tokens=0 lines=0"
                    print(f"[{engine_name}] region={args.region} {msg} out={output_filename}")

        # Save results
        print(f"Saving filtered data to: {output_path}")
        save_json(result, output_path)

        print(f"Output saved to: {output_path}")

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()