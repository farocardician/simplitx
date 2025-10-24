#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Extract, print, export, and compare text contained inside S03 regions.
Now supports:
  - --json <path>: export tokenizer->regions->{key,value} JSON
  - --compare <gold.json>: compare current extraction vs a saved JSON gold
  - --compare-json <path>: also write a machine-readable JSON report for LLMs/automation
"""
import argparse
import json
import sys
import os
import re
import difflib
from typing import List, Dict, Any, Tuple, Optional


# -------------------------
# Utilities: IO & geometry
# -------------------------
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
        return [bbox.get('x0', 0.0), bbox.get('y0', 0.0), bbox.get('x1', 0.0), bbox.get('y1', 0.0)]
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


# -------------------------
# Token iteration & lines
# -------------------------
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


def normalize_text(text: str) -> str:
    """
    Normalize text:
    - Lowercase
    - Replace [.,:;()\-\/] with spaces
    - Collapse multiple spaces to one; trim
    """
    text = text.lower()
    text = re.sub(r'[.,:;()\-\/]', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def reconstruct_lines(tokens: List[Dict[str, Any]], row_gap: float) -> List[str]:
    """Group tokens into lines and reconstruct text."""
    if not tokens:
        return []

    # Sort tokens by (y_center, x-center)
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
            current_line.append(token)
        else:
            if current_line:
                lines.append(current_line)
            current_line = [token]

        last_y = cy

    if current_line:
        lines.append(current_line)

    # Sort tokens within each line by x position and reconstruct text
    result = []
    for line in lines:
        line.sort(key=lambda t: token_center(t.get('bbox', [0, 0, 0, 0]))[0])  # x center
        texts = [token.get('text', '').strip() for token in line if token.get('text', '').strip()]
        if texts:
            line_text = ' '.join(texts)
            line_text = re.sub(r'\s+', ' ', line_text).strip()
            if line_text:
                result.append(line_text)

    return result


def extract_region_text(s02_data: Dict[str, Any], region_bbox: List[float], region_page: int, tokenizer: Optional[str], row_gap: float, touch_ok: bool) -> Dict[str, List[str]]:
    """Extract text from a specific region and return results grouped by tokenizer."""
    matching_tokens = []

    for token in iter_tokens_from_s02(s02_data, tokenizer):
        # Check page
        token_page = token.get('page', 1)
        if token_page != region_page:
            continue

        token_bbox = token.get('bbox')
        token_text = token.get('text', '').strip()
        if not token_bbox or not token_text:
            continue

        normalized_bbox = normalize_bbox(token_bbox)
        if not normalized_bbox or len(normalized_bbox) != 4:
            continue

        if bbox_intersects(normalized_bbox, region_bbox, touch_ok):
            matching_tokens.append(token)

    # Group tokens by tokenizer source if unspecified
    if tokenizer is None:
        tokenizer_groups: Dict[str, List[Dict[str, Any]]] = {}
        for token in matching_tokens:
            source = token.get('_tokenizer_source', 'unknown')
            tokenizer_groups.setdefault(source, []).append(token)

        result: Dict[str, List[str]] = {}
        for tokenizer_name in ['plumber', 'pymupdf', 'unknown']:
            if tokenizer_name in tokenizer_groups:
                result[tokenizer_name] = reconstruct_lines(tokenizer_groups[tokenizer_name], row_gap)
        return result
    else:
        return {tokenizer: reconstruct_lines(matching_tokens, row_gap)}


def extract_multipage_region_text(s02_data: Dict[str, Any], parts: List[Dict[str, Any]], tokenizer: Optional[str], row_gap: float, touch_ok: bool) -> Dict[str, List[str]]:
    """
    Extract text from a multi-page region by stitching together parts.

    Args:
        s02_data: S02 tokens data
        parts: List of part dictionaries with id, page, bbox
        tokenizer: Optional tokenizer filter
        row_gap: Line grouping threshold
        touch_ok: Whether edge-touching tokens count as inside

    Returns:
        Dictionary mapping tokenizer names to list of lines (stitched from all parts)
    """
    # Sort parts by page then by y-coordinate to ensure proper ordering
    sorted_parts = sorted(parts, key=lambda p: (p.get('page', 1), p.get('bbox', [0, 0, 0, 0])[1]))

    # Collect all tokens from all parts, grouped by tokenizer
    all_tokens_by_tokenizer: Dict[str, List[Dict[str, Any]]] = {}

    for part in sorted_parts:
        part_page = part.get('page', 1)
        part_bbox = part.get('bbox')

        if not part_bbox or len(part_bbox) != 4:
            continue  # Skip invalid part

        # Find tokens matching this part
        for token in iter_tokens_from_s02(s02_data, tokenizer):
            token_page = token.get('page', 1)
            if token_page != part_page:
                continue

            token_bbox = token.get('bbox')
            token_text = token.get('text', '').strip()
            if not token_bbox or not token_text:
                continue

            normalized_bbox = normalize_bbox(token_bbox)
            if not normalized_bbox or len(normalized_bbox) != 4:
                continue

            if bbox_intersects(normalized_bbox, part_bbox, touch_ok):
                # Add page info to token for sorting later
                token_with_page = dict(token)
                token_with_page['_part_page'] = part_page
                token_with_page['_part_y'] = part_bbox[1]  # Top of part bbox

                # Group by tokenizer
                source = token_with_page.get('_tokenizer_source', 'unknown')
                if tokenizer is not None and source != tokenizer:
                    continue

                all_tokens_by_tokenizer.setdefault(source, []).append(token_with_page)

    # Reconstruct lines for each tokenizer from all collected tokens
    result: Dict[str, List[str]] = {}

    for tokenizer_name, tokens in all_tokens_by_tokenizer.items():
        if not tokens:
            continue

        # Sort tokens by (part_page, part_y, line_y, x) to maintain reading order
        def sort_key(token):
            bbox = token.get('bbox', [0, 0, 0, 0])
            cx, cy = token_center(bbox)
            return (token.get('_part_page', 1), token.get('_part_y', 0), cy, cx)

        sorted_tokens = sorted(tokens, key=sort_key)

        # Group into lines using row_gap, but don't group across part boundaries
        lines = []
        current_line = []
        last_y = None
        last_part_page = None
        last_part_y = None

        for token in sorted_tokens:
            bbox = token.get('bbox', [0, 0, 0, 0])
            _, cy = token_center(bbox)
            part_page = token.get('_part_page', 1)
            part_y = token.get('_part_y', 0)

            # Start new line if:
            # 1. This is the first token
            # 2. We're on a different part (new page or different region)
            # 3. We're on the same part but y-coordinate changed beyond row_gap
            if (last_y is None or
                part_page != last_part_page or
                part_y != last_part_y or
                abs(cy - last_y) > row_gap):

                # Save previous line if exists
                if current_line:
                    lines.append(current_line)
                current_line = [token]
            else:
                current_line.append(token)

            last_y = cy
            last_part_page = part_page
            last_part_y = part_y

        if current_line:
            lines.append(current_line)

        # Sort tokens within each line by x position and reconstruct text
        region_lines = []
        for line in lines:
            line.sort(key=lambda t: token_center(t.get('bbox', [0, 0, 0, 0]))[0])  # x center
            texts = [token.get('text', '').strip() for token in line if token.get('text', '').strip()]
            if texts:
                line_text = ' '.join(texts)
                line_text = re.sub(r'\s+', ' ', line_text).strip()
                if line_text:
                    region_lines.append(line_text)

        if region_lines:
            result[tokenizer_name] = region_lines

    return result


# ----------------------------------------------
# Helpers for JSON export / comparison
# ----------------------------------------------
def parse_client_variant_from_path(token_path: str) -> Tuple[str, Optional[int]]:
    """
    Try to parse client and variant from a typical path like:
    services/pdf2json/results/<client>/<variant>/s02.json
    services/pdf2json/training/<client>/<variant>/s02.json
    or results/<client>/<variant>/s02.json
    or training/<client>/<variant>/s02.json
    """
    # Normalize separators
    parts = token_path.replace('\\', '/').split('/')
    client = "unknown"
    variant: Optional[int] = None

    try:
        # Find "results" or "training" and take next two parts
        for dir_name in ["results", "training"]:
            if dir_name in parts:
                idx = parts.index(dir_name)
                if idx + 2 < len(parts):
                    client = parts[idx + 1]
                    variant_str = parts[idx + 2]
                    if variant_str.isdigit():
                        variant = int(variant_str)
                    else:
                        # If not purely digits, try to coerce safely
                        m = re.match(r'(\d+)', variant_str)
                        if m:
                            variant = int(m.group(1))
                        else:
                            variant = None
                break
    except Exception:
        pass

    return client, variant


def extract_all_regions_to_map(
    s02_data: Dict[str, Any],
    s03_segments: List[Dict[str, Any]],
    tokenizer_choice: Optional[str],
    row_gap: float,
    touch_ok: bool,
    only_region_id: Optional[str] = None
) -> Dict[str, Dict[str, str]]:
    """
    Returns a nested map:
      { "<tokenizer>": { "<region_id>": "<joined text>" } }
    Only includes non-empty values.
    If tokenizer_choice is specified, returns only that branch.
    Handles both single-page and multi-page regions.
    """
    # First pass: identify multi-page regions and collect single-page regions
    multipage_regions: Dict[str, List[Dict[str, Any]]] = {}
    singlepage_regions: List[Dict[str, Any]] = []
    processed_ids: set = set()

    # Process segments to identify multi-page regions
    for seg in s03_segments:
        region_id = seg.get('id', 'unknown')

        # Skip if we've already processed this region (for multi-page)
        if region_id in processed_ids:
            continue

        # Check if this is a multi-page region with parts
        if seg.get('spanning') is True and seg.get('parts') and isinstance(seg.get('parts'), list) and seg.get('parts'):
            # Multi-page region
            multipage_regions[region_id] = seg
            processed_ids.add(region_id)
        else:
            # Check if there are other segments with the same ID on different pages (fallback for older configs)
            same_id_segments = [s for s in s03_segments if s.get('id') == region_id]
            if len(same_id_segments) > 1:
                # Multiple segments with same ID - treat as multi-page
                # Create a pseudo-segment with parts from all pages
                parts = []
                for s in same_id_segments:
                    if s.get('bbox') and len(s.get('bbox')) == 4:
                        parts.append({
                            'id': s.get('id', region_id),
                            'page': s.get('page', 1),
                            'bbox': s.get('bbox')
                        })
                if parts:
                    # Sort parts by page
                    parts.sort(key=lambda p: p.get('page', 1))
                    pseudo_seg = {
                        'id': region_id,
                        'spanning': True,
                        'parts': parts
                    }
                    multipage_regions[region_id] = pseudo_seg
                    processed_ids.add(region_id)
                    # Mark all these segments as processed
                    for s in same_id_segments:
                        processed_ids.add(s.get('id', 'unknown'))
            else:
                # Single-page region
                singlepage_regions.append(seg)
                processed_ids.add(region_id)

    # Filter by only_region_id if specified
    if only_region_id:
        if only_region_id in multipage_regions:
            multipage_regions = {only_region_id: multipage_regions[only_region_id]}
            singlepage_regions = []
        else:
            singlepage_regions = [seg for seg in singlepage_regions if seg.get('id') == only_region_id]
            multipage_regions = {}

        if not singlepage_regions and not multipage_regions:
            print(f"Region '{only_region_id}' not found for comparison/export.", file=sys.stderr)
            sys.exit(2)

    # tokenizers to consider
    tokenizers = ['plumber', 'pymupdf'] if tokenizer_choice is None else [tokenizer_choice]

    out: Dict[str, Dict[str, str]] = {tok: {} for tok in tokenizers}

    # Process multi-page regions
    for region_id, seg in multipage_regions.items():
        parts = seg.get('parts', [])
        if not parts:
            continue

        # Extract text using multi-page function
        tokenized_texts = extract_multipage_region_text(
            s02_data, parts, None if tokenizer_choice is None else tokenizer_choice, row_gap, touch_ok
        )

        for tok_name, lines in tokenized_texts.items():
            if tok_name not in out:
                continue
            if not lines:
                continue
            joined = ' '.join(lines).strip()
            if joined:
                out[tok_name][region_id] = joined

    # Process single-page regions
    for seg in singlepage_regions:
        region_id = seg.get('id', 'unknown')
        region_bbox = seg.get('bbox')
        region_page = seg.get('page', 1)
        if not region_bbox or len(region_bbox) != 4:
            # Skip invalid bbox regions
            continue

        # Extract for requested tokenizer(s)
        tokenized_texts = extract_region_text(s02_data, region_bbox, region_page, None if tokenizer_choice is None else tokenizer_choice, row_gap, touch_ok)

        for tok_name, lines in tokenized_texts.items():
            if tok_name not in out:
                # If user asked for a specific tokenizer, tokenized_texts will only contain that branch.
                # If both, tokenized_texts may include 'unknown'—ignore that for our structure.
                continue
            if not lines:
                continue
            joined = ' '.join(lines).strip()
            if joined:
                out[tok_name][region_id] = joined

    return out


def build_result_json(
    client: str,
    variant: Optional[int],
    gold_version: str,
    tokenizer_map: Dict[str, Dict[str, str]]
) -> Dict[str, Any]:
    """
    Build final JSON structure:
    {
      client, variant, gold_version,
      tokenizer: {
        plumber: { regions: [ {key, value}, ... ] },
        pymupdf: { regions: [ {key, value}, ... ] }
      }
    }
    Only include tokenizers that have at least one region.
    """
    result: Dict[str, Any] = {
        "client": client,
        "variant": variant if variant is not None else "unknown",
        "gold_version": gold_version,
        "tokenizer": {}
    }

    for tok_name in ['plumber', 'pymupdf']:
        if tok_name in tokenizer_map and tokenizer_map[tok_name]:
            regions_list = [{"key": k, "value": v} for k, v in tokenizer_map[tok_name].items()]
            result["tokenizer"][tok_name] = {"regions": regions_list}

    return result


def gold_to_map(gold: Dict[str, Any], tokenizer_filter: Optional[str] = None, only_region_id: Optional[str] = None) -> Dict[str, Dict[str, str]]:
    """
    Convert saved gold JSON (tokenizer -> regions list) into:
      { "<tokenizer>": { "<key>": "<value>" } }
    Optionally filter by tokenizer and/or single region id.
    """
    out: Dict[str, Dict[str, str]] = {}
    tok_block = gold.get("tokenizer", {})
    for tok_name, payload in tok_block.items():
        if tokenizer_filter and tok_name != tokenizer_filter:
            continue
        regions = payload.get("regions", [])
        if not isinstance(regions, list):
            continue
        kv: Dict[str, str] = {}
        for item in regions:
            key = str(item.get("key", "")).strip()
            value = str(item.get("value", "")).strip()
            if not key:
                continue
            if only_region_id and key != only_region_id:
                continue
            kv[key] = value
        if kv:
            out[tok_name] = kv
    return out


# ---------- AI-friendly JSON compare ----------
def compare_maps_structured(
    new_map: Dict[str, Dict[str, str]],
    gold_map: Dict[str, Dict[str, str]],
    meta: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Build a machine-readable diff:
    {
      "meta": {...},
      "summary": {
        "overall_ok": true,
        "tokenizers": [{"name":"plumber","matched":8,"total":9,"accuracy":0.8889}, ...]
      },
      "results": {
        "plumber": [
          {"key":"invoice_number","status":"MATCH","gold_raw":"..","new_raw":"..","gold_norm":"..","new_norm":"..","similarity":1.0}
        ],
        "pymupdf": [ ... ]
      }
    }
    """
    results: Dict[str, List[Dict[str, Any]]] = {}
    tok_summaries: List[Dict[str, Any]] = []
    overall_ok = True

    tokenizer_names = sorted(set(list(new_map.keys()) + list(gold_map.keys())))
    for tok in tokenizer_names:
        entries: List[Dict[str, Any]] = []
        new_kv = new_map.get(tok, {})
        gold_kv = gold_map.get(tok, {})

        all_keys = sorted(set(list(new_kv.keys()) + list(gold_kv.keys())))
        match_count = 0
        for key in all_keys:
            item: Dict[str, Any] = {"key": key}
            new_val = new_kv.get(key)
            gold_val = gold_kv.get(key)

            if new_val is None and gold_val is not None:
                item.update({
                    "status": "MISSING_IN_NEW",
                    "gold_raw": gold_val,
                    "new_raw": None,
                    "gold_norm": normalize_text(gold_val),
                    "new_norm": None,
                    "similarity": 0.0
                })
                overall_ok = False
            elif new_val is not None and gold_val is None:
                item.update({
                    "status": "MISSING_IN_GOLD",
                    "gold_raw": None,
                    "new_raw": new_val,
                    "gold_norm": None,
                    "new_norm": normalize_text(new_val),
                    "similarity": 0.0
                })
                overall_ok = False
            else:
                n_new = normalize_text(new_val or "")
                n_gold = normalize_text(gold_val or "")
                sim = difflib.SequenceMatcher(None, n_new, n_gold).ratio()
                if n_new == n_gold:
                    item.update({
                        "status": "MATCH",
                        "gold_raw": gold_val,
                        "new_raw": new_val,
                        "gold_norm": n_gold,
                        "new_norm": n_new,
                        "similarity": 1.0
                    })
                    match_count += 1
                else:
                    item.update({
                        "status": "MISMATCH",
                        "gold_raw": gold_val,
                        "new_raw": new_val,
                        "gold_norm": n_gold,
                        "new_norm": n_new,
                        "similarity": sim
                    })
                    overall_ok = False

            entries.append(item)

        total = len(all_keys)
        acc = (match_count / total) if total else 1.0
        tok_summaries.append({"name": tok, "matched": match_count, "total": total, "accuracy": acc})
        results[tok] = entries

    summary = {"overall_ok": overall_ok, "tokenizers": tok_summaries}
    return {"meta": meta, "summary": summary, "results": results}


def compare_maps_text(
    new_map: Dict[str, Dict[str, str]],
    gold_map: Dict[str, Dict[str, str]]
) -> Tuple[bool, str]:
    """
    Legacy human-readable comparison.
    """
    lines: List[str] = []
    all_ok = True

    tokenizer_names = sorted(set(list(new_map.keys()) + list(gold_map.keys())))
    for tok in tokenizer_names:
        lines.append(f"=== {tok} ===")
        new_kv = new_map.get(tok, {})
        gold_kv = gold_map.get(tok, {})

        all_keys = sorted(set(list(new_kv.keys()) + list(gold_kv.keys())))
        match_count = 0
        for key in all_keys:
            new_val = new_kv.get(key)
            gold_val = gold_kv.get(key)

            if new_val is None and gold_val is not None:
                lines.append(f"[{key}] ✗ missing in NEW")
                lines.append(f"  GOLD: {gold_val}")
                lines.append(f"  NEW : <empty>")
                all_ok = False
                continue
            if new_val is not None and gold_val is None:
                lines.append(f"[{key}] ✗ missing in GOLD")
                lines.append(f"  GOLD: <empty>")
                lines.append(f"  NEW : {new_val}")
                all_ok = False
                continue

            # Both present -> compare normalized
            n_new = normalize_text(new_val or "")
            n_gold = normalize_text(gold_val or "")
            if n_new == n_gold:
                lines.append(f"[{key}] ✓ MATCH")
                match_count += 1
            else:
                sim = difflib.SequenceMatcher(None, n_new, n_gold).ratio()
                lines.append(f"[{key}] ✗ MISMATCH (sim={sim:.3f})")
                lines.append(f"  GOLD: {gold_val}")
                lines.append(f"  NEW : {new_val}")
                all_ok = False

        total = len(all_keys)
        pct = (match_count / total * 100.0) if total else 100.0
        lines.append(f"Summary for {tok}: {match_count}/{total} matched ({pct:.1f}%)")
        lines.append("")

    return all_ok, "\n".join(lines).strip()


def prompt_user_overwrite(file_path: str) -> bool:
    """Prompt user whether to overwrite existing file."""
    while True:
        response = input(f"File '{file_path}' already exists. Use --overwrite-json next time to overwrite automatically. Overwrite now? [y/N]: ").strip().lower()
        if not response or response in ['n', 'no']:
            return False
        elif response in ['y', 'yes']:
            return True
        else:
            print("Please enter 'y' or 'n'.")


# -------------------------
# CLI main
# -------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Extract text from S03 regions; print, export JSON, or compare against a saved JSON gold."
    )
    parser.add_argument('--token', required=True,
                       help='Path to S02 tokens JSON file')
    parser.add_argument('--segmen', required=True,
                       help='Path to S03 segments JSON file')
    parser.add_argument('--region-id',
                       help='Region ID to process. If omitted, processes all regions. Applies to export and compare as well.')
    parser.add_argument('--row-gap', type=float, default=0.006,
                       help='Line grouping threshold (default: 0.006)')
    parser.add_argument('--touch-ok', action='store_true', default=True,
                       help='Count edge-touching tokens as inside (default: True)')
    parser.add_argument('--no-touch-ok', dest='touch_ok', action='store_false',
                       help='Do not count edge-touching tokens as inside')
    parser.add_argument('--lines', action='store_true',
                       help='Print one line per row (legacy print mode)')
    parser.add_argument('--text', action='store_true',
                       help='Print as a single paragraph (legacy print mode)')
    parser.add_argument('--tokenizer', choices=['plumber', 'pymupdf'],
                       help='Specify tokenizer source (plumber or pymupdf). If not specified, exports/compares both.')
    parser.add_argument('--normalized', action='store_true',
                       help='Show normalized text alongside original text (legacy print mode)')
    parser.add_argument('--check-coverage',
                       help='(Legacy) Check if provided text is fully covered by the region. File path or multiline string.')
    # New features
    parser.add_argument('--json',
                       help='Export extraction to JSON at this path (s03-simple.v1 structure).')
    parser.add_argument('--overwrite-json', action='store_true',
                       help='Overwrite existing JSON file without prompting.')
    parser.add_argument('--compare',
                       help='Compare current extraction against a saved JSON gold at this path. Exit non-zero on mismatch.')
    parser.add_argument('--compare-json',
                       help='Also write a machine-readable JSON report for the comparison to this path.')

    args = parser.parse_args()

    # Default legacy behavior: if neither --json nor --compare nor print flags are passed, default to --lines
    if not args.lines and not args.text and not args.json and not args.compare:
        args.lines = True

    # Load data
    s03_data = load_json(args.segmen)
    segments = s03_data.get('segments', [])
    s02_data = load_json(args.token)

    # Helper: derive client/variant for JSON header
    client, variant = parse_client_variant_from_path(args.token)

    # Branch: Compare takes priority if both are passed
    if args.compare or args.compare_json:
        if not args.compare:
            print("--compare-json requires --compare <gold.json>", file=sys.stderr)
            sys.exit(2)

        gold = load_json(args.compare)
        # Build current extraction map (tokenizer -> {key: value})
        current_map = extract_all_regions_to_map(
            s02_data=s02_data,
            s03_segments=segments,
            tokenizer_choice=args.tokenizer,
            row_gap=args.row_gap,
            touch_ok=args.touch_ok,
            only_region_id=args.region_id
        )
        # Build gold map (tokenizer -> {key: value})
        gold_map = gold_to_map(
            gold=gold,
            tokenizer_filter=args.tokenizer,
            only_region_id=args.region_id
        )

        # If tokenizer specified and missing in gold, warn early
        if args.tokenizer and args.tokenizer not in gold_map:
            print(f"Warning: tokenizer '{args.tokenizer}' not found in gold file. Nothing to compare.", file=sys.stderr)

        # Text report
        all_ok, report = compare_maps_text(current_map, gold_map)
        print(report)

        # Optional JSON report
        if args.compare_json:
            meta = {
                "client": client,
                "variant": variant if variant is not None else "unknown",
                "gold_path": os.path.abspath(args.compare),
                "token_path": os.path.abspath(args.token),
                "segmen_path": os.path.abspath(args.segmen),
                "filters": {"tokenizer": args.tokenizer or "both", "region_id": args.region_id or None}
            }
            structured = compare_maps_structured(current_map, gold_map, meta)
            try:
                out_dir = os.path.dirname(args.compare_json)
                if out_dir:
                    os.makedirs(out_dir, exist_ok=True)
                with open(args.compare_json, 'w', encoding='utf-8') as f:
                    json.dump(structured, f, indent=2, ensure_ascii=False)
                print(f"Saved compare JSON to {args.compare_json}")
            except Exception as e:
                print(f"Error: failed to write compare JSON to {args.compare_json}: {e}", file=sys.stderr)
                sys.exit(1)

        sys.exit(0 if all_ok else 1)

    # Branch: JSON export
    if args.json:
        tokenizer_map = extract_all_regions_to_map(
            s02_data=s02_data,
            s03_segments=segments,
            tokenizer_choice=args.tokenizer,
            row_gap=args.row_gap,
            touch_ok=args.touch_ok,
            only_region_id=args.region_id
        )
        result = build_result_json(
            client=client,
            variant=variant,
            gold_version="s03-simple.v1",
            tokenizer_map=tokenizer_map
        )

        # Check if file exists and handle overwrite logic
        if os.path.exists(args.json):
            if not args.overwrite_json:
                if not prompt_user_overwrite(args.json):
                    print("Operation cancelled by user.")
                    sys.exit(0)

        try:
            os.makedirs(os.path.dirname(args.json), exist_ok=True) if os.path.dirname(args.json) else None
            with open(args.json, 'w', encoding='utf-8') as f:
                json.dump(result, f, indent=2, ensure_ascii=False)
            print(f"Saved JSON to {args.json}")
            sys.exit(0)
        except Exception as e:
            print(f"Error: failed to write JSON to {args.json}: {e}", file=sys.stderr)
            sys.exit(1)

    # -------------------------------
    # Legacy print behavior (updated for multi-page support)
    # -------------------------------
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

        # Check if this is a multi-page region
        is_multipage = False
        parts = None

        if target_segment.get('spanning') is True and target_segment.get('parts') and isinstance(target_segment.get('parts'), list) and target_segment.get('parts'):
            # New format with explicit parts
            is_multipage = True
            parts = target_segment.get('parts')
        else:
            # Check for older config with multiple segments having same ID
            same_id_segments = [s for s in segments if s.get('id') == args.region_id]
            if len(same_id_segments) > 1:
                is_multipage = True
                parts = []
                for s in same_id_segments:
                    if s.get('bbox') and len(s.get('bbox')) == 4:
                        parts.append({
                            'id': s.get('id', args.region_id),
                            'page': s.get('page', 1),
                            'bbox': s.get('bbox')
                        })
                # Sort by page
                parts.sort(key=lambda p: p.get('page', 1))

        # Extract text for this region
        if is_multipage and parts:
            # Multi-page extraction
            tokenizer_results = extract_multipage_region_text(s02_data, parts, args.tokenizer, args.row_gap, args.touch_ok)
            print(f"Note: Region '{args.region_id}' spans {len(parts)} page(s)", file=sys.stderr)
        else:
            # Single-page extraction
            region_bbox = target_segment.get('bbox')
            if not region_bbox or len(region_bbox) != 4:
                print(f"Region '{args.region_id}' has no valid bbox", file=sys.stderr)
                sys.exit(2)

            region_page = target_segment.get('page', 1)
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
                    print(f"  - [{i}] FOUND: '{line}'")
                else:
                    print(f"  - [{i}] MISSING: '{line}'")
                    missing_count += 1

            print(f"\n" + "="*50)
            print(f"COVERAGE SUMMARY")
            print(f"="*50)
            print(f"Total required lines: {len(required_normalized_lines)}")
            print(f"Missing lines: {missing_count}")
            coverage_pct = ((len(required_normalized_lines) - missing_count) / len(required_normalized_lines)) * 100 if required_normalized_lines else 0
            print(f"Coverage: {coverage_pct:.1f}%")

            if missing_count == 0:
                print("\nSUCCESS: ALL REQUIRED TEXT IS CAPTURED!")
            else:
                print(f"\nFAILURE: {missing_count} lines still missing")
    else:
        # Extract all available regions (legacy print mode)
        if not segments:
            print("No segments found in the S03 file", file=sys.stderr)
            sys.exit(1)

        # First, identify unique regions (handle multi-page)
        unique_regions = []
        processed_ids = set()

        for segment in segments:
            region_id = segment.get('id', 'unknown')
            if region_id in processed_ids:
                continue

            # Check if this is multi-page
            if segment.get('spanning') is True and segment.get('parts') and isinstance(segment.get('parts'), list) and segment.get('parts'):
                # New format multi-page
                unique_regions.append({
                    'segment': segment,
                    'is_multipage': True,
                    'parts': segment.get('parts')
                })
                processed_ids.add(region_id)
            else:
                # Check for older config with multiple segments having same ID
                same_id_segments = [s for s in segments if s.get('id') == region_id]
                if len(same_id_segments) > 1:
                    # Multi-page in older format
                    parts = []
                    for s in same_id_segments:
                        if s.get('bbox') and len(s.get('bbox')) == 4:
                            parts.append({
                                'id': s.get('id', region_id),
                                'page': s.get('page', 1),
                                'bbox': s.get('bbox')
                            })
                    if parts:
                        parts.sort(key=lambda p: p.get('page', 1))
                        unique_regions.append({
                            'segment': segment,
                            'is_multipage': True,
                            'parts': parts
                        })
                        processed_ids.add(region_id)
                        for s in same_id_segments:
                            processed_ids.add(s.get('id', 'unknown'))
                else:
                    # Single-page
                    unique_regions.append({
                        'segment': segment,
                        'is_multipage': False,
                        'parts': None
                    })
                    processed_ids.add(region_id)

        print(f"Found {len(unique_regions)} unique region(s):\n")

        for i, region_info in enumerate(unique_regions):
            segment = region_info['segment']
            is_multipage = region_info['is_multipage']
            parts = region_info['parts']

            region_id = segment.get('id', 'unknown')
            region_bbox = segment.get('bbox')
            region_page = segment.get('page', 1)

            if not region_bbox or len(region_bbox) != 4:
                print(f"[{i+1}] Region '{region_id}' - INVALID BBOX")
                continue

            if is_multipage and parts:
                pages = sorted(set(p.get('page', 1) for p in parts))
                print(f"[{i+1}] Region: {region_id} (MULTI-PAGE: pages {', '.join(map(str, pages))})")
                print(f"    Parts: {len(parts)} part(s)")
            else:
                print(f"[{i+1}] Region: {region_id} (Page {region_page})")

            print(f"    Bbox: {region_bbox}")

            # Extract text for this region
            if is_multipage and parts:
                tokenizer_results = extract_multipage_region_text(s02_data, parts, args.tokenizer, args.row_gap, args.touch_ok)
            else:
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
