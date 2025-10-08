#!/usr/bin/env python3
"""
Header Region AI - Find header region of tokenized invoice using Ollama model.
"""

import argparse
import json
import math
import sys
import textwrap
import urllib.request
import urllib.parse
import urllib.error
from collections import defaultdict
from itertools import groupby
from typing import Dict, List, Any, Tuple, Optional


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Find header region of tokenized invoice using Ollama model"
    )
    parser.add_argument(
        "--tokens", required=True, help="Path to token JSON file"
    )
    parser.add_argument(
        "--host", default="http://localhost:11434", help="Ollama base URL"
    )
    parser.add_argument(
        "--model", default="qwen3:4b-instruct-2507-q8_0", help="Ollama model name"
    )
    parser.add_argument(
        "--page", type=int, default=1, help="Page number to analyze (1-indexed)"
    )
    parser.add_argument(
        "--out", default="headerRegionAi.json", help="Output JSON path"
    )
    parser.add_argument(
        "--debug", action="store_true", help="Debug mode: skip Ollama call and use mock response"
    )
    return parser.parse_args()


def load_tokens(path: str) -> List[Dict[str, Any]]:
    """Load tokens from JSON file."""
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        # Handle different token file formats
        tokens = []

        # Direct list format
        if isinstance(data, list):
            tokens = data
        # Nested format with different engines
        elif isinstance(data, dict):
            # Try different possible token locations
            for engine in ["plumber", "pymupdf", "tokens"]:
                if engine in data and "tokens" in data[engine]:
                    tokens = data[engine]["tokens"]
                    break
            # If no engine found, maybe direct tokens in data
            if not tokens and "tokens" in data:
                tokens = data["tokens"]

        if not isinstance(tokens, list):
            raise ValueError("Token file must contain a list of tokens")

        return tokens
    except (FileNotFoundError, json.JSONDecodeError, ValueError) as e:
        print(f"Error loading tokens: {e}", file=sys.stderr)
        sys.exit(1)


def normalize_token(token: Dict[str, Any], page_width: float, page_height: float) -> Dict[str, Any]:
    """Normalize token coordinates."""
    norm_token = token.copy()

    # Get absolute bbox
    abs_bbox = token.get("abs_bbox", {})
    if not abs_bbox:
        # Fallback to bbox or construct from coordinates
        if "bbox" in token:
            abs_bbox = token["bbox"]
        else:
            # Try to construct from individual coordinates
            abs_bbox = {
                "x0": token.get("x0", 0),
                "y0": token.get("y0", 0),
                "x1": token.get("x1", token.get("x0", 0)),
                "y1": token.get("y1", token.get("y0", 0))
            }

    # Normalize coordinates
    x0, y0 = abs_bbox.get("x0", 0), abs_bbox.get("y0", 0)
    x1, y1 = abs_bbox.get("x1", x0), abs_bbox.get("y1", y0)

    norm_token.update({
        "nx0": x0 / page_width,
        "ny0": y0 / page_height,
        "nx1": x1 / page_width,
        "ny1": y1 / page_height
    })

    return norm_token


def group_lines(tokens: List[Dict[str, Any]], tolerance: float = 0.006) -> List[Dict[str, Any]]:
    """Group tokens into lines based on y-coordinates."""
    if not tokens:
        return []

    # Sort by y0, then x0 for proper reading order
    sorted_tokens = sorted(tokens, key=lambda t: (t["ny0"], t["nx0"]))

    lines = []
    current_line_tokens = []
    current_y = None

    for token in sorted_tokens:
        token_y = token["ny0"]

        if current_y is None or abs(token_y - current_y) > tolerance:
            # Start new line
            if current_line_tokens:
                # Save previous line
                line = create_line_from_tokens(current_line_tokens)
                lines.append(line)

            current_line_tokens = [token]
            current_y = token_y
        else:
            # Add to current line
            current_line_tokens.append(token)

    # Don't forget the last line
    if current_line_tokens:
        line = create_line_from_tokens(current_line_tokens)
        lines.append(line)

    return lines


def create_line_from_tokens(tokens: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Create a line object from a list of tokens."""
    # Sort tokens by x0 for proper reading order within line
    tokens_sorted = sorted(tokens, key=lambda t: t["nx0"])

    # Calculate line bbox
    min_x0 = min(t["nx0"] for t in tokens_sorted)
    min_y0 = min(t["ny0"] for t in tokens_sorted)
    max_x1 = max(t["nx1"] for t in tokens_sorted)
    max_y1 = max(t["ny1"] for t in tokens_sorted)

    # Join text with spaces
    line_text = " ".join(t["text"] for t in tokens_sorted if t["text"].strip())

    return {
        "line_index": None,  # Will be set later
        "token_ids": [t["id"] for t in tokens_sorted],
        "line_text": line_text,
        "line_bbox": {
            "x0": min_x0, "y0": min_y0,
            "x1": max_x1, "y1": max_y1
        },
        "mid_ny": (min_y0 + max_y1) / 2
    }


def build_header_snippet(lines: List[Dict[str, Any]], tokens: List[Dict[str, Any]]) -> Tuple[str, str, List[int]]:
    """Build header candidate snippet for LLM."""
    # Header cue keywords
    header_cues = [
        "invoice", "inv", "ti", "no", "number", "date",
        "terms", "balance due", "commercial"
    ]

    # Choose lines based on heuristics
    chosen_lines = []
    chosen_indices = []

    for i, line in enumerate(lines):
        mid_y = line["mid_ny"]
        text_lower = line["line_text"].lower()

        # Include if in top 25% OR contains header cues
        if mid_y < 0.25 or any(cue in text_lower for cue in header_cues):
            chosen_lines.append((i, line))
            chosen_indices.append(i)

    # Limit to at most 60 lines
    chosen_lines = chosen_lines[:60]
    chosen_indices = chosen_indices[:60]

    # Build lines string
    lines_parts = []
    for line_idx, line in chosen_lines:
        mid_ny = line["mid_ny"]
        token_ids = ",".join(map(str, line["token_ids"]))
        text = line["line_text"]
        lines_parts.append(f"[L{line_idx}] y={mid_ny:.3f} ids={token_ids}  text=\"{text}\"")

    lines_str = "\n".join(lines_parts)

    # Build tokens CSV for chosen lines only
    chosen_token_ids = set()
    for _, line in chosen_lines:
        chosen_token_ids.update(line["token_ids"])

    # Create token lookup
    token_by_id = {t["id"]: t for t in tokens}

    # Build CSV
    tokens_parts = ["token_id,page,ny0,ny1,text"]
    for token_id in sorted(chosen_token_ids):
        if token_id in token_by_id:
            token = token_by_id[token_id]
            text = token["text"].replace('"', '""')  # Escape quotes
            tokens_parts.append(f"{token_id},{token['page']},{token['ny0']:.3f},{token['ny1']:.3f},\"{text}\"")

    tokens_csv = "\n".join(tokens_parts)

    return lines_str, tokens_csv, chosen_indices


def ollama_chat(host: str, model: str, system: str, user: str, options: Dict[str, Any]) -> Dict[str, Any]:
    """Call Ollama API chat endpoint."""
    url = f"{host.rstrip('/')}/api/chat"

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ],
        "options": options,
        "stream": False
    }

    data = json.dumps(payload).encode('utf-8')
    headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }

    try:
        req = urllib.request.Request(url, data=data, headers=headers, method='POST')
        with urllib.request.urlopen(req, timeout=60) as response:
            result = json.loads(response.read().decode('utf-8'))

        if "message" not in result or "content" not in result["message"]:
            raise ValueError("Invalid response format from Ollama")

        return json.loads(result["message"]["content"])

    except urllib.error.URLError as e:
        print(f"Error calling Ollama API: {e}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"Error parsing Ollama response: {e}", file=sys.stderr)
        return {"error": "Invalid JSON response"}


def compute_bbox(tokens_by_id: Dict[int, Dict[str, Any]]) -> Dict[str, float]:
    """Compute normalized bbox covering all selected tokens."""
    if not tokens_by_id:
        return {"x0": 0, "y0": 0, "x1": 0, "y1": 0}

    min_x0 = min(t["nx0"] for t in tokens_by_id.values())
    min_y0 = min(t["ny0"] for t in tokens_by_id.values())
    max_x1 = max(t["nx1"] for t in tokens_by_id.values())
    max_y1 = max(t["ny1"] for t in tokens_by_id.values())

    return {"x0": min_x0, "y0": min_y0, "x1": max_x1, "y1": max_y1}


def validate_llm_response(response: Dict[str, Any]) -> Dict[str, Any]:
    """Validate and normalize LLM response."""
    if "error" in response:
        return response

    # Ensure required fields exist
    validated = {
        "token_ids": response.get("token_ids", []),
        "text": response.get("text", ""),
        "bbox": response.get("bbox", {}),
        "confidence": response.get("confidence", 0.0)
    }

    # Validate types
    if not isinstance(validated["token_ids"], list):
        validated["token_ids"] = []

    if not isinstance(validated["text"], str):
        validated["text"] = str(validated["text"])

    if not isinstance(validated["bbox"], dict):
        validated["bbox"] = {}

    if not isinstance(validated["confidence"], (int, float)):
        validated["confidence"] = float(validated["confidence"])

    # Ensure token_ids are unique and sorted
    validated["token_ids"] = sorted(list(set(validated["token_ids"])))

    return validated


def compute_confidence(response: Dict[str, Any], tokens_by_id: Dict[int, Dict[str, Any]]) -> float:
    """Compute confidence score if missing from response."""
    if response.get("confidence", 0) > 0:
        return response["confidence"]

    confidence = 0.8  # Base confidence

    # Check if majority of tokens are in top 20% of page
    top_tokens = sum(1 for t in tokens_by_id.values() if t["ny0"] < 0.2)
    if len(tokens_by_id) > 0 and top_tokens / len(tokens_by_id) > 0.5:
        confidence += 0.1

    # Check for header keywords
    header_keywords = ["invoice", "commercial", "number", "date", "terms"]
    text_lower = response.get("text", "").lower()
    if any(keyword in text_lower for keyword in header_keywords):
        confidence += 0.1

    return min(confidence, 1.0)


def main():
    """Main function."""
    args = parse_args()

    # Load and filter tokens
    tokens = load_tokens(args.tokens)
    page_tokens = [t for t in tokens if t.get("page") == args.page]

    if not page_tokens:
        print(f"No tokens found for page {args.page}", file=sys.stderr)
        sys.exit(1)

    # Determine page dimensions
    # First try to get from pages array if available
    try:
        with open(args.tokens, 'r', encoding='utf-8') as f:
            full_data = json.load(f)

        if isinstance(full_data, dict) and "pages" in full_data:
            page_info = full_data["pages"][0]  # Get first page
            page_width, page_height = page_info["width"], page_info["height"]
        else:
            # Use first token's abs_bbox to estimate page size
            first_bbox = page_tokens[0].get("abs_bbox", {})
            if "width" in first_bbox and "height" in first_bbox:
                page_width, page_height = first_bbox["width"], first_bbox["height"]
            else:
                # Default to A4-like dimensions if not available
                page_width, page_height = 595.0, 842.0
    except:
        # Fallback to first token or default
        first_bbox = page_tokens[0].get("abs_bbox", {})
        if "width" in first_bbox and "height" in first_bbox:
            page_width, page_height = first_bbox["width"], first_bbox["height"]
        else:
            page_width, page_height = 595.0, 842.0

    # Normalize tokens
    norm_tokens = [normalize_token(t, page_width, page_height) for t in page_tokens]

    # Group into lines
    lines = group_lines(norm_tokens)

    # Assign line indices
    for i, line in enumerate(lines):
        line["line_index"] = i

    # Build header snippet
    lines_str, tokens_csv, chosen_line_indices = build_header_snippet(lines, norm_tokens)

    # Prepare Ollama request
    system_content = textwrap.dedent("""\
        Task: From the provided lines and token table, select the tokens that form the document HEADER region.
        Definition: The HEADER is the top identity block of an invoice (logo/seller name/address) and the small header band containing labels like "Commercial Invoice", "Invoice No", "TI No", "Invoice Date", "Terms", or "Balance Due".
        Rules:
        - Prefer lines within the top quarter of the page (ny <= 0.25), but include header labels even if slightly lower.
        - Use ONLY token_ids present in the provided table.
        - Return strict JSON only, no prose.
        Output schema:
        {
          "token_ids": [int, ...],          // unique, sorted
          "text": "string",                 // concatenation of the selected lines (preserve natural order)
          "bbox": { "x0": float, "y0": float, "x1": float, "y1": float },  // normalized box covering all selected tokens
          "confidence": float               // 0..1 heuristic
        }
        If you are unsure, return the most likely small set; never invent token ids.""")

    user_content = f"""\
        PAGE: {args.page}
        LINES:
        <<<LINES
        {lines_str}
        LINES>>>
        TOKENS:
        <<<TOKENS
        {tokens_csv}
        TOKENS>>>
        Return JSON only."""

    options = {"temperature": 0, "top_p": 0.1, "format": "json"}

    # Call Ollama or use debug mode
    if args.debug:
        print("Debug mode: using mock response", file=sys.stderr)
        response = {
            "token_ids": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
            "text": "INVOICE TO: PT PERTAMINA TRAINING AND CONSULTING Invoice Number 11/INV-7/2025 Invoice Date 25-Jul-25",
            "bbox": {"x0": 0.094, "y0": 0.094, "x1": 0.879, "y1": 0.175},
            "confidence": 0.95
        }
    else:
        response = ollama_chat(args.host, args.model, system_content, user_content, options)

        # Handle retry if response is not valid JSON
        if "error" in response:
            print("Retrying with explicit JSON instruction...", file=sys.stderr)
            user_content += "\nOutput JSON only."
            response = ollama_chat(args.host, args.model, system_content, user_content, options)

        if "error" in response:
            print(f"Failed to get valid response from Ollama: {response['error']}", file=sys.stderr)
            sys.exit(1)

    # Validate and process response
    validated_response = validate_llm_response(response)

    # Get selected tokens
    token_by_id = {t["id"]: t for t in norm_tokens}
    selected_tokens = {tid: token_by_id[tid] for tid in validated_response["token_ids"] if tid in token_by_id}

    # Compute bbox if missing
    if not validated_response["bbox"] and selected_tokens:
        validated_response["bbox"] = compute_bbox(selected_tokens)

    # Compute confidence if missing
    validated_response["confidence"] = compute_confidence(validated_response, selected_tokens)

    # Prepare final output
    output = {
        "page": args.page,
        "token_ids": validated_response["token_ids"],
        "text": validated_response["text"],
        "bbox": validated_response["bbox"],
        "confidence": validated_response["confidence"],
        "lines_used": chosen_line_indices
    }

    # Write output
    try:
        with open(args.out, 'w', encoding='utf-8') as f:
            json.dump(output, f, indent=2, ensure_ascii=False)
    except IOError as e:
        print(f"Error writing output: {e}", file=sys.stderr)
        sys.exit(1)

    # Print summary
    num_tokens = len(output["token_ids"])
    bbox = output["bbox"]
    confidence = output["confidence"]
    print(f"Header tokens: {num_tokens}, bbox=[{bbox['x0']:.3f},{bbox['y0']:.3f},{bbox['x1']:.3f},{bbox['y1']:.3f}], confidence={confidence:.2f}")


if __name__ == "__main__":
    main()