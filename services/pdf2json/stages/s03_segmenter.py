#!/usr/bin/env python3
"""
Stage 3 – Agnostic Region-Based Segmenter (Revised)
A fully generic document segmenter with strict page grammar and keep policies.

Stitching (post-processing)
---------------------------
After all detect/fallback passes and keep policies, fragments that belong to a
single logical region (e.g., a total/footer split across pages) are stitched
into a canonical region.

Example (simplified):
  "segments": [
    {"id": "total_bottom", "page": 1, "bbox": [0.68, 0.86, 0.98, 0.97],
     "metadata": {"split_group": "total"}},
    {"id": "total_top",    "page": 2, "bbox": [0.68, 0.03, 0.98, 0.15],
     "metadata": {"split_group": "total"}},

    {"id": "total", "page": 1, "spanning": true, "label": "total",
     "bbox": [0.68, 0.03, 0.98, 0.97],
     "parts": [
       {"id": "total_bottom", "page": 1, "bbox": [0.68,0.86,0.98,0.97]},
       {"id": "total_top",    "page": 2, "bbox": [0.68,0.03,0.98,0.15]}
     ],
     "metadata": {"role": "canonical", "stitched_from": ["total_bottom","total_top"]}}
  ]

Fragments remain for debugging but are marked with metadata.role="fragment"; the
canonical carries metadata.role="canonical".
"""

from __future__ import annotations
import argparse
import json
import re
import logging
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple, Union, Callable, Sequence, Set
from collections import defaultdict, deque

# PDF overlay generation (optional dependency)
try:
    import fitz  # PyMuPDF
    PDF_OVERLAY_AVAILABLE = True
except ImportError:
    PDF_OVERLAY_AVAILABLE = False
    fitz = None

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# ============================================================================
# Data Models
# ============================================================================

@dataclass
class BBox:
    """Normalized bounding box with validation."""
    x0: float
    y0: float
    x1: float
    y1: float
    
    def __post_init__(self):
        """Validate and normalize coordinates."""
        # Ensure proper ordering
        self.x0, self.x1 = min(self.x0, self.x1), max(self.x0, self.x1)
        self.y0, self.y1 = min(self.y0, self.y1), max(self.y0, self.y1)
        
        # Clamp to [0,1] range
        self.x0 = max(0.0, min(1.0, self.x0))
        self.y0 = max(0.0, min(1.0, self.y0))
        self.x1 = max(0.0, min(1.0, self.x1))
        self.y1 = max(0.0, min(1.0, self.y1))
        
        # Ensure minimum dimensions
        min_dim = 1e-6
        if self.x1 - self.x0 < min_dim:
            self.x1 = min(1.0, self.x0 + min_dim)
        if self.y1 - self.y0 < min_dim:
            self.y1 = min(1.0, self.y0 + min_dim)
    
    def to_list(self, precision: int = 6) -> List[float]:
        """Convert to list format with specified precision."""
        return [
            round(self.x0, precision),
            round(self.y0, precision),
            round(self.x1, precision),
            round(self.y1, precision)
        ]
    
    @property
    def area(self) -> float:
        """Area of the box (normalized units)."""
        return max(0.0, self.x1 - self.x0) * max(0.0, self.y1 - self.y0)
    
    def intersection(self, other: 'BBox') -> 'BBox':
        """Intersection box (may degenerate to min-dim)."""
        ix0 = max(self.x0, other.x0)
        iy0 = max(self.y0, other.y0)
        ix1 = min(self.x1, other.x1)
        iy1 = min(self.y1, other.y1)
        return BBox(ix0, iy0, ix1, iy1)
    
    def iou(self, other: 'BBox') -> float:
        """Intersection over Union of two boxes."""
        inter = self.intersection(other).area
        union = self.area + other.area - inter
        if union <= 0:
            return 0.0
        return inter / union
    
    @staticmethod
    def union_many(boxes: List['BBox']) -> 'BBox':
        """Union envelope across many boxes."""
        if not boxes:
            return BBox(0.0, 0.0, 0.0, 0.0)
        x0 = min(b.x0 for b in boxes)
        y0 = min(b.y0 for b in boxes)
        x1 = max(b.x1 for b in boxes)
        y1 = max(b.y1 for b in boxes)
        return BBox(x0, y0, x1, y1)
    
    def clip_to(self, parent: 'BBox') -> 'BBox':
        """Return a new bbox clipped to parent bounds."""
        return BBox(
            max(self.x0, parent.x0),
            max(self.y0, parent.y0),
            min(self.x1, parent.x1),
            min(self.y1, parent.y1)
        )
    
    @classmethod
    def from_list(cls, coords: List[float]) -> 'BBox':
        """Create from list of coordinates."""
        if len(coords) != 4:
            raise ValueError(f"Expected 4 coordinates, got {len(coords)}")
        return cls(*coords)


@dataclass
class Context:
    """Runtime context for region detection."""
    page: int
    total_pages: int
    tokens: List[Dict[str, Any]]
    rows: List[List[Dict[str, Any]]]
    table_provider: 'TableProvider'
    config: Dict[str, Any]
    logger: logging.Logger
    parent_bbox: Optional[BBox] = None
    defaults: Dict[str, Any] = field(default_factory=dict)
    lines: Optional[List[Dict[str, Any]]] = None
    lines_available: bool = False


@dataclass  
class DetectionResult:
    """Result from a detection mode."""
    bbox: BBox
    metadata: Dict[str, Any] = field(default_factory=dict)


# ============================================================================
# Mode Normalization
# ============================================================================

class ModeNormalizer:
    """Normalize detection mode specifications to canonical format."""
    
    @staticmethod
    def normalize(mode_spec: Union[str, Dict[str, Any]]) -> Dict[str, Any]:
        """
        Normalize a mode specification to {by: "name", ...params}.
        
        Accepts:
        - String: "anchors" -> {by: "anchors"}
        - Single-key dict: {"anchors": {...}} -> {by: "anchors", ...params}
        - Canonical dict: {by: "anchors", ...} -> unchanged
        """
        if isinstance(mode_spec, str):
            logger.debug(f"Normalizing string mode: {mode_spec}")
            return {"by": mode_spec}
        
        if isinstance(mode_spec, dict):
            # Already has 'by' key - canonical format
            if "by" in mode_spec:
                logger.debug(f"Mode already canonical: {mode_spec}")
                return mode_spec
            
            # Single-key shorthand
            if len(mode_spec) == 1:
                mode_name = list(mode_spec.keys())[0]
                params = mode_spec[mode_name]
                logger.debug(f"Normalizing single-key mode: {mode_name}")
                
                if isinstance(params, dict):
                    return {"by": mode_name, **params}
                else:
                    return {"by": mode_name, "value": params}
            
            # Multi-key dict without 'by' - ambiguous
            logger.warning(f"Ambiguous mode specification (multiple keys, no 'by'): {mode_spec}")
            return None
        
        logger.warning(f"Invalid mode type: {type(mode_spec)}")
        return None
    
    @staticmethod
    def normalize_chain(detect_config: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Normalize a detection chain (detect + fallbacks) to list of canonical dicts."""
        chain = []
        
        # Primary mode
        if "detect" in detect_config:
            normalized = ModeNormalizer.normalize(detect_config["detect"])
            if normalized:
                chain.append(normalized)
        
        # Fallbacks
        if "fallbacks" in detect_config:
            fallbacks = detect_config["fallbacks"]
            if not isinstance(fallbacks, list):
                fallbacks = [fallbacks]
            
            for fallback in fallbacks:
                normalized = ModeNormalizer.normalize(fallback)
                if normalized:
                    chain.append(normalized)
                else:
                    logger.warning(f"Skipping invalid fallback: {fallback}")
        
        logger.debug(f"Normalized chain: {chain}")
        return chain


# ============================================================================
# Table Detection
# ============================================================================

class TableProvider:
    """Provides table detection with fallback strategies."""
    
    def __init__(self):
        self._cache: Dict[int, List[BBox]] = {}
    
    def get_tables(self, ctx: Context) -> List[BBox]:
        """Get tables for a page using cached or detected results."""
        if ctx.page in self._cache:
            return self._cache[ctx.page]
        
        tables = self._detect_tables(ctx)
        self._cache[ctx.page] = tables
        return tables
    
    def _detect_tables(self, ctx: Context) -> List[BBox]:
        """Detect tables using lightweight heuristics."""
        tables = []
        
        # Find header row patterns
        for ridx, row in enumerate(ctx.rows):
            if self._is_table_header(row):
                # Find table extent
                table_bbox = self._find_table_extent(ctx.rows, ridx)
                if table_bbox:
                    tables.append(table_bbox)
        
        return tables
    
    def _is_table_header(self, row: List[Dict[str, Any]]) -> bool:
        """
        Check if a row looks like a table header.

        This method is deprecated and should not be used for new config-driven detection.
        All table header patterns should be specified in config files.
        """
        # Return False - this method should not be used
        # All table header detection should be config-driven
        return False
    
    def _find_table_extent(self, rows: List[List[Dict[str, Any]]], 
                          header_idx: int) -> Optional[BBox]:
        """Find the bounding box of a table starting from header row."""
        if header_idx >= len(rows):
            return None
        
        header_row = rows[header_idx]
        min_cols = len(header_row)
        
        # Find last row with similar column structure
        last_idx = header_idx
        for ridx in range(header_idx + 1, len(rows)):
            if len(rows[ridx]) >= min_cols - 1:  # Allow some variation
                last_idx = ridx
            else:
                # Stop at significant structure change
                if last_idx > header_idx + 2:  # At least 3 rows
                    break
        
        # Calculate bbox from first to last row
        all_tokens = []
        for ridx in range(header_idx, last_idx + 1):
            all_tokens.extend(rows[ridx])
        
        if not all_tokens:
            return None
        
        x0 = min(t["bbox"]["x0"] for t in all_tokens)
        y0 = min(t["bbox"]["y0"] for t in all_tokens)
        x1 = max(t["bbox"]["x1"] for t in all_tokens)
        y1 = max(t["bbox"]["y1"] for t in all_tokens)
        
        return BBox(x0, y0, x1, y1)


# ============================================================================
# Detection Modes
# ============================================================================

class DetectionModes:
    """Registry of detection mode handlers."""
    
    @staticmethod
    def anchors(ctx: Context,
                start_anchor: Dict[str, Any],
                end_anchor: Optional[Dict[str, Any]] = None,
                margin: Optional[Dict[str, float]] = None,
                capture_window: Optional[Dict[str, Any]] = None,
                **kwargs) -> Optional[DetectionResult]:
        """
        Detect region using anchor patterns.
        
        Supports optional `capture_window` directly under detect:
          "detect": {
            "by": "anchors",
            "start_anchor": { ... },
            "capture_window": {
              "mode": "right_then_down",
              "dx_max": 0.3,
              "dy_max": 0.15,
              "dy_tol": 0.008
            }
          }
        """
        # Merge defaults if not overridden
        if margin is None and "margin" in ctx.defaults:
            margin = ctx.defaults["margin"]

        # 1) Find start anchor
        start_match = AnchorMatcher.match(ctx.tokens, start_anchor)
        if not start_match:
            return None

        # 2) If capture_window is provided, prefer it over end_anchor logic
        if capture_window:
            cw_bbox = DetectionModes._capture_window_bbox(
                ctx=ctx,
                start_bbox=start_match["bbox"],
                capture_window=capture_window
            )
            if cw_bbox is None:
                return None
            x0, y0, x1, y1 = cw_bbox.x0, cw_bbox.y0, cw_bbox.x1, cw_bbox.y1

        else:
            # Optional end anchor path (legacy anchor-to-anchor box)
            end_match = None
            if end_anchor:
                end_match = AnchorMatcher.match(ctx.tokens, end_anchor, start_match)
                if not end_match:
                    return None

            if end_match:
                x0 = min(start_match["bbox"][0], end_match["bbox"][0])
                y0 = min(start_match["bbox"][1], end_match["bbox"][1])
                x1 = max(start_match["bbox"][2], end_match["bbox"][2])
                y1 = max(start_match["bbox"][3], end_match["bbox"][3])
            else:
                x0, y0, x1, y1 = start_match["bbox"]

        # 3) Apply margins
        if margin:
            x0 -= margin.get("left", 0.0)
            y0 -= margin.get("top", 0.0)
            x1 += margin.get("right", 0.0)
            y1 += margin.get("bottom", 0.0)

        # 4) Enforce minimum height if configured
        if "min_height" in ctx.defaults:
            min_h = float(ctx.defaults["min_height"])
            if (y1 - y0) < min_h:
                y1 = y0 + min_h

        bbox = BBox(x0, y0, x1, y1)

        return DetectionResult(
            bbox=bbox,
            metadata={
                "mode": "anchors",
                "start_anchor": start_match.get("matched_text"),
                "used_capture_window": bool(capture_window)
            }
        )

    @staticmethod
    def line_anchors(ctx: Context,
                     start_anchor: Dict[str, Any],
                     end_anchor: Optional[Dict[str, Any]] = None,
                     margin: Optional[Dict[str, float]] = None,
                     capture_window: Optional[Dict[str, Any]] = None,
                     **kwargs) -> Optional[DetectionResult]:
        """Detect region using anchors evaluated over line aggregates."""
        if not ctx.lines_available:
            return None

        if margin is None and "margin" in ctx.defaults:
            margin = ctx.defaults["margin"]

        line_records = ctx.lines or []
        if not line_records:
            return None

        candidates: List[Dict[str, Any]] = []
        for line in line_records:
            text = str(line.get("text", "")).strip()
            bbox_obj = line.get("bbox")
            if not text or bbox_obj is None:
                continue

            if isinstance(bbox_obj, BBox):
                bbox = bbox_obj
            elif isinstance(bbox_obj, dict):
                try:
                    bbox = BBox(
                        float(bbox_obj["x0"]),
                        float(bbox_obj["y0"]),
                        float(bbox_obj["x1"]),
                        float(bbox_obj["y1"]),
                    )
                except (KeyError, TypeError, ValueError):
                    continue
            else:
                try:
                    x0, y0, x1, y1 = bbox_obj
                    bbox = BBox(float(x0), float(y0), float(x1), float(y1))
                except (TypeError, ValueError):
                    continue

            candidates.append({
                "norm": text,
                "text": text,
                "page": ctx.page,
                "bbox": {
                    "x0": bbox.x0,
                    "y0": bbox.y0,
                    "x1": bbox.x1,
                    "y1": bbox.y1,
                },
                "_source_line": line,
            })

        if not candidates:
            return None

        start_match = AnchorMatcher.match(candidates, start_anchor)
        if not start_match:
            return None

        start_bbox_list = [float(v) for v in start_match["bbox"]]

        # Refine with tokens if requested
        if capture_window and capture_window.get("refine_with_tokens", False):
            refined_bbox = DetectionModes._refine_line_match_with_tokens(
                ctx=ctx,
                line_bbox=start_bbox_list,
                anchor_config=start_anchor,
                matched_text=start_match.get("matched_text", "")
            )
            if refined_bbox:
                start_bbox_list = refined_bbox
                ctx.logger.debug(f"Refined line bbox with tokens: {start_bbox_list}")

        if capture_window:
            cw_bbox = DetectionModes._capture_window_bbox(
                ctx=ctx,
                start_bbox=start_bbox_list,
                capture_window=capture_window,
            )
            if cw_bbox is None:
                return None
            x0, y0, x1, y1 = cw_bbox.x0, cw_bbox.y0, cw_bbox.x1, cw_bbox.y1
        else:
            end_match = None
            if end_anchor:
                end_match = AnchorMatcher.match(candidates, end_anchor, start_match)
                if not end_match:
                    return None

            x0, y0, x1, y1 = start_bbox_list
            if end_match:
                ex0, ey0, ex1, ey1 = [float(v) for v in end_match["bbox"]]
                x0 = min(x0, ex0)
                y0 = min(y0, ey0)
                x1 = max(x1, ex1)
                y1 = max(y1, ey1)

        if margin:
            x0 -= margin.get("left", 0.0)
            y0 -= margin.get("top", 0.0)
            x1 += margin.get("right", 0.0)
            y1 += margin.get("bottom", 0.0)

        if "min_height" in ctx.defaults:
            min_h = float(ctx.defaults["min_height"])
            if (y1 - y0) < min_h:
                y1 = y0 + min_h

        bbox = BBox(x0, y0, x1, y1)

        return DetectionResult(
            bbox=bbox,
            metadata={
                "mode": "line_anchors",
                "start_anchor": start_match.get("matched_text"),
                "used_capture_window": bool(capture_window),
            },
        )

    @staticmethod
    def _refine_line_match_with_tokens(ctx: Context,
                                       line_bbox: Sequence[float],
                                       anchor_config: Dict[str, Any],
                                       matched_text: str) -> Optional[List[float]]:
        """
        Refine a line-level match by finding the exact token span that matches the anchor pattern.

        Process:
        1. Collect tokens that intersect with the line bbox
        2. Join their texts left→right
        3. Re-run the anchor regex to find the exact character span
        4. Map the character span back to the minimal consecutive token span
        5. Return the union bbox of those tokens
        """
        lx0, ly0, lx1, ly1 = map(float, line_bbox)

        # Find tokens that intersect with the line bbox (with small y tolerance)
        y_tol = 0.005
        line_tokens = []
        for token in ctx.tokens:
            tx0 = token["bbox"]["x0"]
            ty0 = token["bbox"]["y0"]
            tx1 = token["bbox"]["x1"]
            ty1 = token["bbox"]["y1"]

            # Check y overlap
            if ty1 < ly0 - y_tol or ty0 > ly1 + y_tol:
                continue
            # Check x overlap
            if tx1 < lx0 or tx0 > lx1:
                continue

            line_tokens.append(token)

        if not line_tokens:
            ctx.logger.debug("No tokens found intersecting line bbox")
            return None

        # Sort tokens left to right
        line_tokens.sort(key=lambda t: (t["bbox"]["x0"], t["bbox"]["y0"]))

        # Build concatenated text with character positions
        # We need to track which character range belongs to which token
        token_map = []  # List of (start_char, end_char, token_index)
        full_text = []
        char_pos = 0

        for idx, token in enumerate(line_tokens):
            text = token.get("norm", token.get("text", ""))
            if idx > 0:
                # Add space between tokens
                full_text.append(" ")
                char_pos += 1

            start_char = char_pos
            full_text.append(text)
            char_pos += len(text)
            end_char = char_pos

            token_map.append((start_char, end_char, idx))

        full_text_str = "".join(full_text)

        # Compile the anchor pattern and find the match
        patterns = anchor_config.get("patterns", anchor_config.get("pattern", ""))
        if isinstance(patterns, str):
            patterns = [patterns]

        flags = anchor_config.get("flags", {})
        regex_flags = 0
        if flags.get("ignore_case", False):
            regex_flags |= re.IGNORECASE

        # Normalize space if required
        search_text = full_text_str
        if flags.get("normalize_space", False):
            search_text = " ".join(search_text.split())

        # Find the match
        match_obj = None
        for pattern in patterns:
            try:
                pattern_re = re.compile(pattern, regex_flags)
                match_obj = pattern_re.search(search_text)
                if match_obj:
                    break
            except re.error as e:
                ctx.logger.warning(f"Invalid regex '{pattern}': {e}")

        if not match_obj:
            ctx.logger.debug("Regex did not match in token-refined text")
            return None

        # Get character span of the match
        match_start, match_end = match_obj.span()

        # Map character span back to token indices
        # Find all tokens that overlap with [match_start, match_end)
        involved_tokens = []
        for start_char, end_char, token_idx in token_map:
            # Check if this token overlaps with the match span
            if end_char <= match_start or start_char >= match_end:
                continue
            involved_tokens.append(token_idx)

        if not involved_tokens:
            ctx.logger.debug("No tokens map to the regex match span")
            return None

        # Get the union bbox of involved tokens
        min_idx = min(involved_tokens)
        max_idx = max(involved_tokens)
        span_tokens = line_tokens[min_idx:max_idx + 1]

        if not span_tokens:
            return None

        refined_x0 = min(t["bbox"]["x0"] for t in span_tokens)
        refined_y0 = min(t["bbox"]["y0"] for t in span_tokens)
        refined_x1 = max(t["bbox"]["x1"] for t in span_tokens)
        refined_y1 = max(t["bbox"]["y1"] for t in span_tokens)

        ctx.logger.debug(f"Token refinement: '{search_text}' -> matched '{match_obj.group()}' -> {len(span_tokens)} tokens")

        return [refined_x0, refined_y0, refined_x1, refined_y1]

    @staticmethod
    def _capture_window_bbox(ctx: Context,
                             start_bbox: Sequence[float],
                             capture_window: Dict[str, Any]) -> Optional[BBox]:
        """
        Build a capture window relative to the start anchor and return the union
        bbox of tokens inside it. If no tokens are found, return the window
        rectangle so downstream logic still receives a usable bbox.

        Supported capture_window modes (normalized units [0..1], y_origin=top):

        Coordinate-oriented:
          - "right_then_down" | "right_then_up"
          - "left_then_down"  | "left_then_up"
          - "right_only"      | "left_only"
          - "below_only"
          - "around"

        Row/line–oriented:
          - "right_then_rows" | "left_then_rows"
          - "below_rows"      | "above_rows"

        Common params:
          - dx_max, dy_max, dy_tol  (>=0)
          - rows, row_tol (rows>=1)
          - width: "anchor"|"page" (for below*/above*), pad_left, pad_right
          - NEW: start_edge: "right"|"left"  (where to measure from; applies to right*/left* modes)
          - NEW: gap_x >= 0                 (small horizontal buffer away from the anchor edge)
        """
        mode = (capture_window.get("mode") or "right_then_down").lower()

        # Anchor box
        ax0, ay0, ax1, ay1 = map(float, start_bbox)
        anchor_center_y = 0.5 * (ay0 + ay1)

        # Defaults shared across modes - clamp to non-negative values
        dx_max_raw = float(capture_window.get("dx_max", 0.35))
        dy_max_raw = float(capture_window.get("dy_max", 0.15))
        dy_tol_raw = float(capture_window.get("dy_tol", 0.008))
        gap_x_raw  = float(capture_window.get("gap_x", 0.0))

        # Clamp and warn if negative
        dx_max = max(0.0, dx_max_raw)
        dy_max = max(0.0, dy_max_raw)
        dy_tol = max(0.0, dy_tol_raw)
        gap_x  = max(0.0, gap_x_raw)

        if dx_max_raw < 0:
            ctx.logger.warning(f"capture_window.dx_max is negative ({dx_max_raw}), clamped to 0")
        if dy_max_raw < 0:
            ctx.logger.warning(f"capture_window.dy_max is negative ({dy_max_raw}), clamped to 0")
        if dy_tol_raw < 0:
            ctx.logger.warning(f"capture_window.dy_tol is negative ({dy_tol_raw}), clamped to 0")
        if gap_x_raw < 0:
            ctx.logger.warning(f"capture_window.gap_x is negative ({gap_x_raw}), clamped to 0")

        # Helpers for row grouping
        def _build_rows(tokens: Sequence[Dict[str, Any]], row_tol: float) -> List[Dict[str, Any]]:
            if not tokens:
                return []
            toks = sorted(tokens, key=lambda t: 0.5*(t["bbox"]["y0"] + t["bbox"]["y1"]))
            rows: List[Dict[str, Any]] = []
            cur = None
            for t in toks:
                y0, y1 = t["bbox"]["y0"], t["bbox"]["y1"]
                yc = 0.5 * (y0 + y1)
                if cur is None:
                    cur = {"y0": y0, "y1": y1, "x0": t["bbox"]["x0"], "x1": t["bbox"]["x1"],
                           "center": yc, "tokens": [t]}
                    continue
                if abs(yc - cur["center"]) <= row_tol:
                    cur["tokens"].append(t)
                    cur["y0"] = min(cur["y0"], y0)
                    cur["y1"] = max(cur["y1"], y1)
                    cur["x0"] = min(cur["x0"], t["bbox"]["x0"])
                    cur["x1"] = max(cur["x1"], t["bbox"]["x1"])
                    cur["center"] = (cur["center"]*0.9) + (yc*0.1)
                else:
                    rows.append(cur)
                    cur = {"y0": y0, "y1": y1, "x0": t["bbox"]["x0"], "x1": t["bbox"]["x1"],
                           "center": yc, "tokens": [t]}
            if cur:
                rows.append(cur)
            return rows

        def _anchor_row_index(rows: List[Dict[str, Any]]) -> int:
            if not rows:
                return -1
            for i, r in enumerate(rows):
                if r["y0"] <= anchor_center_y <= r["y1"]:
                    return i
            nearest_i, best = 0, float("inf")
            for i, r in enumerate(rows):
                d = abs(r["center"] - anchor_center_y)
                if d < best:
                    best, nearest_i = d, i
            return nearest_i

        # Row params
        rows_n    = int(capture_window.get("rows", 1))
        row_tol   = float(capture_window.get("row_tol", dy_tol))
        width_kind = (capture_window.get("width") or "anchor").lower()
        pad_left  = float(capture_window.get("pad_left", 0.0))
        pad_right = float(capture_window.get("pad_right", 0.0))

        # Resolve start edge default by mode family
        def _start_edge_for_mode(m: str) -> str:
            if m.startswith("right"):
                return str(capture_window.get("start_edge", "right")).lower()
            if m.startswith("left"):
                return str(capture_window.get("start_edge", "left")).lower()
            return str(capture_window.get("start_edge", "")).lower()  # ignored elsewhere

        start_edge = _start_edge_for_mode(mode)

        # Precompute rows if needed and normalize structure to dict rows
        page_rows_raw = getattr(ctx, "rows", None)
        if page_rows_raw and isinstance(page_rows_raw, list) and page_rows_raw and isinstance(page_rows_raw[0], dict) and "tokens" in page_rows_raw[0]:
            page_rows: List[Dict[str, Any]] = page_rows_raw  # already normalized rows
        else:
            page_rows = _build_rows(ctx.tokens, row_tol)

        # Compute window coordinates by mode
        if mode == "right_then_down":
            base = ax1 if start_edge != "left" else ax0
            win_x0 = base + gap_x
            win_x1 = min(1.0, win_x0 + dx_max)
            win_y0 = max(0.0, ay0 - dy_tol)
            win_y1 = min(1.0, ay0 + dy_max)

        elif mode == "left_then_down":
            base = ax0 if start_edge != "right" else ax1
            win_x1 = max(0.0, base - gap_x)
            win_x0 = max(0.0, win_x1 - dx_max)
            win_y0 = max(0.0, ay0 - dy_tol)
            win_y1 = min(1.0, ay0 + dy_max)

        elif mode == "right_then_up":
            base = ax1 if start_edge != "left" else ax0
            win_x0 = base + gap_x
            win_x1 = min(1.0, win_x0 + dx_max)
            win_y0 = max(0.0, ay0 - dy_max)
            win_y1 = min(1.0, ay0 + dy_tol)

        elif mode == "left_then_up":
            base = ax0 if start_edge != "right" else ax1
            win_x1 = max(0.0, base - gap_x)
            win_x0 = max(0.0, win_x1 - dx_max)
            win_y0 = max(0.0, ay0 - dy_max)
            win_y1 = min(1.0, ay0 + dy_tol)

        elif mode == "right_only":
            base = ax1 if start_edge != "left" else ax0
            win_x0 = base + gap_x
            win_x1 = min(1.0, win_x0 + dx_max)
            win_y0 = max(0.0, ay0 - dy_tol)
            win_y1 = min(1.0, ay1 + dy_tol)

        elif mode == "left_only":
            base = ax0 if start_edge != "right" else ax1
            win_x1 = max(0.0, base - gap_x)
            win_x0 = max(0.0, win_x1 - dx_max)
            win_y0 = max(0.0, ay0 - dy_tol)
            win_y1 = min(1.0, ay1 + dy_tol)

        elif mode == "below_only":
            if width_kind == "page":
                win_x0, win_x1 = 0.0, 1.0
            else:
                base_x0 = max(0.0, ax0 - pad_left)
                base_x1 = min(1.0, ax1 + pad_right)
                if "dx_max" in capture_window:
                    base_x1 = min(1.0, base_x1 + dx_max)
                win_x0, win_x1 = base_x0, base_x1
            win_y0 = ay1
            win_y1 = min(1.0, ay1 + dy_max)

        elif mode == "around":
            dx = max(0.0, float(capture_window.get("dx", 0.10)))
            dy = max(0.0, float(capture_window.get("dy", 0.05)))
            win_x0 = max(0.0, ax0 - dx)
            win_x1 = min(1.0, ax1 + dx)
            win_y0 = max(0.0, ay0 - dy)
            win_y1 = min(1.0, ay1 + dy)

        # --- Row/line–based modes ---
        elif mode in ("right_then_rows", "left_then_rows", "below_rows", "above_rows"):
            if not page_rows:
                ctx.logger.debug("capture_window row-based mode skipped: no rows available")
                return None
            ai = _anchor_row_index(page_rows)
            if ai < 0:
                return None

            # Select row span
            if mode in ("right_then_rows", "left_then_rows"):
                lo = ai
                hi = min(len(page_rows) - 1, ai + max(0, rows_n - 1))
            elif mode == "below_rows":
                lo = min(len(page_rows) - 1, ai + 1)
                hi = min(len(page_rows) - 1, ai + rows_n)
            else:  # "above_rows"
                lo = max(0, ai - rows_n)
                hi = max(0, ai - 1)

            if lo > hi:
                return None
            span = page_rows[lo:hi+1]

            # Horizontal window for row modes
            if mode == "right_then_rows":
                base = ax1 if start_edge != "left" else ax0
                wx0 = base + gap_x
                wx1 = min(1.0, wx0 + dx_max)
            elif mode == "left_then_rows":
                base = ax0 if start_edge != "right" else ax1
                wx1 = max(0.0, base - gap_x)
                wx0 = max(0.0, wx1 - dx_max)
            elif mode in ("below_rows", "above_rows"):
                if width_kind == "page":
                    wx0, wx1 = 0.0, 1.0
                else:
                    base_x0 = max(0.0, ax0 - pad_left)
                    base_x1 = min(1.0, ax1 + pad_right)
                    if mode == "below_rows" and "dx_max" in capture_window:
                        base_x1 = min(1.0, base_x1 + dx_max)
                    wx0, wx1 = base_x0, base_x1

            # Vertical window from selected rows
            wy0 = min(r["y0"] for r in span)
            wy1 = max(r["y1"] for r in span)

            win_x0, win_x1, win_y0, win_y1 = wx0, wx1, wy0, wy1

        else:
            ctx.logger.debug(f"capture_window mode '{mode}' not supported")
            return None

        # Sanity: clamp, ensure positive area
        win_x0, win_x1 = max(0.0, min(win_x0, win_x1)), min(1.0, max(win_x0, win_x1))
        win_y0, win_y1 = max(0.0, min(win_y0, win_y1)), min(1.0, max(win_y0, win_y1))
        if win_x1 <= win_x0 or win_y1 <= win_y0:
            ctx.logger.warning(
                f"capture_window collapsed to zero area: mode={mode}, "
                f"window=[{win_x0:.3f},{win_y0:.3f},{win_x1:.3f},{win_y1:.3f}], "
                f"params: dx_max={dx_max}, dy_max={dy_max}, gap_x={gap_x}, dy_tol={dy_tol}"
            )
            return None

        # Collect intersecting tokens
        window_tokens = []
        for t in ctx.tokens:
            tb = t["bbox"]
            if tb["x1"] <= win_x0 or tb["x0"] >= win_x1:
                continue
            if tb["y0"] >= win_y1 or tb["y1"] <= win_y0:
                continue
            window_tokens.append(t)

        # If no tokens, return the window itself (respect min_height)
        if not window_tokens:
            min_h = float(ctx.defaults.get("min_height", 0.0))
            if (win_y1 - win_y0) < min_h:
                win_y1 = min(1.0, win_y0 + min_h)
            return BBox(win_x0, win_y0, win_x1, win_y1)

        # Union bbox of window tokens
        x0 = min(t["bbox"]["x0"] for t in window_tokens)
        y0 = min(t["bbox"]["y0"] for t in window_tokens)
        x1 = max(t["bbox"]["x1"] for t in window_tokens)
        y1 = max(t["bbox"]["y1"] for t in window_tokens)
        return BBox(x0, y0, x1, y1)

    @staticmethod
    def by_table(ctx: Context, position: str = "above",
                 which: str = None, margin: float = 0.02,
                 **kwargs) -> Optional[DetectionResult]:
        """Detect region relative to table position."""
        tables = ctx.table_provider.get_tables(ctx)
        if not tables:
            logger.debug("No tables found for by_table mode")
            return None
        
        # Default 'which' based on position
        if which is None:
            which = "first" if position == "above" else "last"
        
        # Select table
        if which == "first":
            table = tables[0]
        elif which == "last":
            table = tables[-1]
        else:
            return None
        
        # Calculate region based on position
        if position == "above":
            bbox = BBox(0.0, 0.0, 1.0, max(0.0, table.y0 - margin))
        elif position == "below":
            bbox = BBox(0.0, min(1.0, table.y1 + margin), 1.0, 1.0)
        else:
            return None
        
        return DetectionResult(
            bbox=bbox,
            metadata={
                "mode": "by_table",
                "position": position,
                "which": which
            }
        )
    
    @staticmethod
    def y_cutoff(ctx: Context, edge: str = "top", y: float = 0.1,
                 **kwargs) -> Optional[DetectionResult]:
        """Detect region using Y-coordinate cutoff."""
        if edge == "top":
            bbox = BBox(0.0, 0.0, 1.0, y)
        elif edge == "bottom":
            bbox = BBox(0.0, y, 1.0, 1.0)
        else:
            return None
        
        return DetectionResult(
            bbox=bbox,
            metadata={
                "mode": "y_cutoff",
                "edge": edge,
                "y": y
            }
        )
    
    @staticmethod
    def fixed_box(ctx: Context, bbox: List[float],
                  **kwargs) -> Optional[DetectionResult]:
        """Use explicit bbox coordinates."""
        try:
            bbox_obj = BBox.from_list(bbox)
            return DetectionResult(
                bbox=bbox_obj,
                metadata={"mode": "fixed_box"}
            )
        except (ValueError, TypeError) as e:
            logger.warning(f"Invalid fixed_box: {e}")
            return None


# ============================================================================
# Anchor Matching
# ============================================================================

class AnchorMatcher:
    """Utility for matching anchor patterns in tokens."""
    
    @staticmethod
    def match(tokens: List[Dict[str, Any]], anchor_config: Dict[str, Any],
              reference: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
        """Match anchor pattern and return best match with metadata."""
        # Get patterns
        patterns = anchor_config.get("patterns", anchor_config.get("pattern", ""))
        if isinstance(patterns, str):
            patterns = [patterns]
        
        # Compile patterns
        flags = anchor_config.get("flags", {})
        regex_flags = 0
        if flags.get("ignore_case", False):
            regex_flags |= re.IGNORECASE
        
        compiled = []
        for pattern in patterns:
            try:
                compiled.append(re.compile(pattern, regex_flags))
            except re.error as e:
                logger.warning(f"Invalid regex '{pattern}': {e}")
        
        if not compiled:
            return None
        
        # Find matches
        matches = []
        for token in tokens:
            text = token.get("norm", token.get("text", ""))
            
            if flags.get("normalize_space", False):
                text = " ".join(text.split())
            
            for pattern_re in compiled:
                if pattern_re.search(text):
                    matches.append({
                        "token": token,
                        "bbox": [
                            token["bbox"]["x0"], token["bbox"]["y0"],
                            token["bbox"]["x1"], token["bbox"]["y1"]
                        ],
                        "matched_text": text,
                        "pattern": pattern_re.pattern
                    })
                    break
        
        if not matches:
            return None
        
        # Apply selection rule
        rule = anchor_config.get("select", "first")
        
        if rule == "leftmost":
            selected = min(matches, key=lambda m: m["bbox"][0])
        elif rule == "rightmost":
            selected = max(matches, key=lambda m: m["bbox"][0])
        elif rule == "topmost":
            selected = min(matches, key=lambda m: m["bbox"][1])
        elif rule == "bottommost":
            selected = max(matches, key=lambda m: m["bbox"][1])
        elif rule == "next_below" and reference:
            ref_y = reference["bbox"][1]
            below = [m for m in matches if m["bbox"][1] > ref_y]
            selected = min(below, key=lambda m: m["bbox"][1]) if below else matches[0]
        else:  # "first" or default
            selected = min(matches, key=lambda m: (m["bbox"][1], m["bbox"][0]))
        
        return selected


# ============================================================================
# Dependency Resolution
# ============================================================================

class DependencyResolver:
    """Resolve region dependencies for topological ordering."""
    
    @staticmethod
    def resolve_order(regions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Return regions in dependency order (parents before children)."""
        # Build dependency graph
        graph = defaultdict(list)  # parent_id -> [child configs]
        roots = []  # Regions with no parent
        by_id = {}  # id -> config
        
        for region in regions:
            region_id = region["id"]
            by_id[region_id] = region
            
            inside = region.get("inside")
            if inside:
                # Remove @ prefix if present
                parent_id = inside.lstrip("@")
                graph[parent_id].append(region)
            else:
                roots.append(region)
        
        # Topological sort using BFS
        ordered = []
        queue = deque(roots)
        
        while queue:
            region = queue.popleft()
            ordered.append(region)
            
            # Add children to queue
            region_id = region["id"]
            if region_id in graph:
                queue.extend(graph[region_id])
        
        return ordered


# ============================================================================
# Page Resolution
# ============================================================================

class PageResolver:
    """Resolve page specifications to actual page numbers."""
    
    VALID_SPECS = {"all", "first", "last", "odd", "even"}
    
    @staticmethod
    def resolve(on_pages: str, total_pages: int) -> List[int]:
        """
        Resolve page specification to list of page numbers.
        
        Supported specs (strict grammar):
        - "all": all pages
        - "first": page 1
        - "last": last page
        - "odd": odd-numbered pages
        - "even": even-numbered pages
        """
        if on_pages not in PageResolver.VALID_SPECS:
            logger.warning(f"Unknown on_pages value: '{on_pages}', defaulting to 'all'")
            on_pages = "all"
        
        if on_pages == "all":
            return list(range(1, total_pages + 1))
        elif on_pages == "first":
            return [1] if total_pages >= 1 else []
        elif on_pages == "last":
            return [total_pages] if total_pages >= 1 else []
        elif on_pages == "odd":
            return [p for p in range(1, total_pages + 1) if p % 2 == 1]
        elif on_pages == "even":
            return [p for p in range(2, total_pages + 1) if p % 2 == 0]
        
        return []


# ============================================================================
# Main Segmenter
# ============================================================================

class AgnosticSegmenter:
    """Agnostic region-based document segmenter with strict grammar."""
    
    def __init__(self, config_path: Optional[Path] = None):
        """Initialize with configuration."""
        if config_path is None:
            config_path = Path(__file__).parent.parent / "config" / "segmenter_config.json"
        
        self.config = self._load_config(config_path)
        self.table_provider = TableProvider()
        self.mode_handlers = self._build_mode_registry()
        self._marker_pattern_cache: Dict[Tuple[str, ...], List[re.Pattern]] = {}
        self._table_header_pattern_cache: Optional[List[re.Pattern]] = None
        # Precompute region config index for quick lookups
        self._region_index: Dict[str, Dict[str, Any]] = {
            r.get("id"): r for r in self.config.get("regions", []) if isinstance(r, dict) and r.get("id")
        }
    
    def _load_config(self, config_path: Path) -> Dict[str, Any]:
        """Load and validate configuration."""
        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                config = json.load(f)
            logger.info(f"Loaded config: {config.get('name', 'Unknown')}")
            return config
        except Exception as e:
            logger.error(f"Failed to load config: {e}")
            raise
    
    def _build_mode_registry(self) -> Dict[str, Callable]:
        """Build registry of mode handlers."""
        return {
            "anchors": DetectionModes.anchors,
            "line_anchors": DetectionModes.line_anchors,
            "by_table": DetectionModes.by_table,
            "y_cutoff": DetectionModes.y_cutoff,
            "fixed_box": DetectionModes.fixed_box,
        }
    
    def _group_rows(self, tokens: List[Dict[str, Any]], page: int,
                    limit_bbox: Optional[BBox] = None) -> List[List[Dict[str, Any]]]:
        """Group tokens into rows by Y coordinate."""
        page_tokens = [t for t in tokens if t["page"] == page]

        if limit_bbox:
            tol = self.config.get("tolerances", {}).get("parent_overlap_tol", 0.0)
            page_tokens = [
                t for t in page_tokens
                if self._token_intersects_bbox(t, limit_bbox, tol)
            ]

        return self._group_rows_from_tokens(page_tokens)

    def _group_rows_from_tokens(self, page_tokens: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
        if not page_tokens:
            return []

        page_tokens = sorted(page_tokens, key=lambda t: (t["bbox"]["y0"], t["bbox"]["x0"]))

        # Group by Y with tolerance
        y_tol = self.config.get("tolerances", {}).get("y_line_tol", 0.006)
        rows: List[List[Dict[str, Any]]] = []
        current_row: List[Dict[str, Any]] = []
        last_y: Optional[float] = None

        for token in page_tokens:
            y = token["bbox"]["y0"]
            if last_y is None or abs(y - last_y) <= y_tol:
                current_row.append(token)
                last_y = y if last_y is None else min(last_y, y)
            else:
                if current_row:
                    rows.append(current_row)
                current_row = [token]
                last_y = y

        if current_row:
            rows.append(current_row)

        # Sort tokens within rows by X
        for row in rows:
            row.sort(key=lambda t: t["bbox"]["x0"])

        return rows

    @staticmethod
    def _bbox_from_tokens(tokens: Sequence[Dict[str, Any]]) -> Optional[BBox]:
        """Compute union bbox for a collection of tokens."""
        boxes: List[BBox] = []
        for token in tokens:
            tb = token.get("bbox") or {}
            try:
                boxes.append(BBox(
                    float(tb["x0"]),
                    float(tb["y0"]),
                    float(tb["x1"]),
                    float(tb["y1"]),
                ))
            except (KeyError, TypeError, ValueError):
                continue

        if not boxes:
            return None

        return BBox.union_many(boxes)

    def _build_line_records(
        self,
        page: int,
        page_tokens: List[Dict[str, Any]],
        rows: List[List[Dict[str, Any]]],
        raw_lines: Optional[List[Dict[str, Any]]],
    ) -> Tuple[Optional[List[Dict[str, Any]]], bool]:
        """Prepare line records enriched with bounding boxes for line anchors."""
        if raw_lines is None:
            return None, False

        if not raw_lines:
            return [], True

        tol_cfg = self.config.get("tolerances", {})
        line_tol = float(tol_cfg.get("y_line_tol", 0.006))

        row_infos: List[Dict[str, Any]] = []
        for row in rows:
            bbox = self._bbox_from_tokens(row)
            if not bbox:
                continue
            row_infos.append({
                "bbox": bbox,
                "y_center": 0.5 * (bbox.y0 + bbox.y1),
                "tokens": row,
            })

        line_records: List[Dict[str, Any]] = []

        for raw_line in raw_lines:
            text = str(raw_line.get("text", "")).strip()
            if not text:
                continue

            raw_bbox = raw_line.get("bbox")
            if isinstance(raw_bbox, dict):
                try:
                    bbox = BBox(
                        float(raw_bbox["x0"]),
                        float(raw_bbox["y0"]),
                        float(raw_bbox["x1"]),
                        float(raw_bbox["y1"]),
                    )
                except (KeyError, TypeError, ValueError):
                    bbox = None
            else:
                bbox = None

            ly0 = float(raw_line.get("y0", 0.0))

            if bbox is None:
                best_row = None
                best_delta = float("inf")
                for info in row_infos:
                    delta = abs(info["y_center"] - ly0)
                    if delta < best_delta:
                        best_delta = delta
                        best_row = info

                if best_row and best_delta <= line_tol:
                    bbox = best_row["bbox"]
                else:
                    # Fallback: gather tokens near the target y position
                    nearby_tokens = []
                    for token in page_tokens:
                        tb = token.get("bbox") or {}
                        try:
                            ty0 = float(tb["y0"])
                            ty1 = float(tb["y1"])
                        except (KeyError, TypeError, ValueError):
                            continue

                        if abs(ty0 - ly0) <= line_tol or (ty0 <= ly0 <= ty1):
                            nearby_tokens.append(token)

                    bbox = self._bbox_from_tokens(nearby_tokens)

            if not bbox:
                continue

            line_records.append({
                "page": page,
                "text": text,
                "y0": ly0,
                "bbox": bbox,
                "raw": raw_line,
            })

        return line_records, True

    @staticmethod
    def _token_intersects_bbox(token: Dict[str, Any], bbox: BBox, tol: float = 0.0) -> bool:
        """Check whether a token's bbox intersects (with tolerance) the given bbox."""
        tb = token.get("bbox") or {}
        if not tb:
            return False
        if tb["x1"] <= (bbox.x0 - tol):
            return False
        if tb["x0"] >= (bbox.x1 + tol):
            return False
        if tb["y1"] <= (bbox.y0 - tol):
            return False
        if tb["y0"] >= (bbox.y1 + tol):
            return False
        return True

    def _resolve_marker_config_value(self, region_config: Dict[str, Any], key: str) -> Any:
        """Resolve marker-related config values with proper precedence."""
        detect_cfg = region_config.get("detect") or {}
        if isinstance(detect_cfg, dict) and key in detect_cfg:
            return detect_cfg.get(key)

        if key in region_config:
            return region_config.get(key)

        defaults = self.config.get("defaults", {})
        if isinstance(defaults, dict) and key in defaults:
            return defaults.get(key)

        return self.config.get(key)

    def _should_drop_page_markers(self, region_config: Dict[str, Any]) -> bool:
        """Determine if page marker removal is enabled for this region."""
        value = self._resolve_marker_config_value(region_config, "drop_page_markers")
        if value is None:
            return False
        return bool(value)

    def _get_marker_patterns(self, region_config: Dict[str, Any]) -> List[re.Pattern]:
        """Load and compile marker regex patterns for the region."""
        raw_patterns = self._resolve_marker_config_value(region_config, "page_marker_patterns")
        if not raw_patterns:
            return []

        if isinstance(raw_patterns, str):
            pattern_list = [raw_patterns]
        elif isinstance(raw_patterns, Sequence):
            pattern_list = [p for p in raw_patterns if isinstance(p, str)]
        else:
            pattern_list = []

        if not pattern_list:
            return []

        cache_key = tuple(pattern_list)
        if cache_key in self._marker_pattern_cache:
            return self._marker_pattern_cache[cache_key]

        compiled: List[re.Pattern] = []
        for pattern in pattern_list:
            try:
                compiled.append(re.compile(pattern, re.IGNORECASE))
            except re.error as exc:
                logger.warning(f"Invalid page marker regex '{pattern}': {exc}")

        self._marker_pattern_cache[cache_key] = compiled
        return compiled

    def _get_table_header_patterns(self) -> List[re.Pattern]:
        """Compile table header whitelist patterns from defaults."""
        if self._table_header_pattern_cache is not None:
            return self._table_header_pattern_cache

        defaults = self.config.get("defaults", {}) or {}
        table_header_detection = defaults.get("table_header_detection", {}) or {}
        raw_patterns = table_header_detection.get("patterns", []) or []

        patterns: List[re.Pattern] = []
        for pattern in raw_patterns:
            if not isinstance(pattern, str):
                continue
            try:
                patterns.append(re.compile(pattern, re.IGNORECASE))
            except re.error as exc:
                logger.warning(f"Invalid table header regex '{pattern}': {exc}")

        self._table_header_pattern_cache = patterns
        return self._table_header_pattern_cache

    @staticmethod
    def _normalize_marker_y_band(band: Any) -> Optional[Tuple[float, float]]:
        """Normalize the optional y band hint to a (y0, y1) tuple."""
        if band is None:
            return None

        try:
            if isinstance(band, (int, float)):
                y0 = float(band)
                y1 = 1.0
            elif isinstance(band, (list, tuple)):
                if len(band) == 0:
                    return None
                if len(band) == 1:
                    y0 = float(band[0])
                    y1 = 1.0
                else:
                    y0 = float(band[0])
                    y1 = float(band[1])
            elif isinstance(band, dict):
                if "y0" in band or "top" in band:
                    y0 = float(band.get("y0", band.get("top", 0.0)))
                else:
                    y0 = 0.0
                if "y1" in band or "bottom" in band:
                    y1 = float(band.get("y1", band.get("bottom", 1.0)))
                else:
                    y1 = 1.0
            else:
                return None
        except (TypeError, ValueError):
            return None

        y0 = max(0.0, min(1.0, y0))
        y1 = max(0.0, min(1.0, y1))
        if y1 < y0:
            y0, y1 = y1, y0

        return (y0, y1)

    @staticmethod
    def _header_repetition_key(text: str) -> str:
        """Normalize header text for repetition checks (case/spacing/digit tolerant)."""
        if not text:
            return ""
        normalized = " ".join(text.split()).lower()
        normalized = re.sub(r"\d+", "#", normalized)
        normalized = re.sub(r"#+", "#", normalized)
        return normalized

    def _get_marker_y_band(self, region_config: Dict[str, Any]) -> Optional[Tuple[float, float]]:
        """Resolve the optional marker y band hint."""
        raw_band = self._resolve_marker_config_value(region_config, "page_marker_y_band")
        return self._normalize_marker_y_band(raw_band)

    @staticmethod
    def _bbox_from_token(token: Dict[str, Any]) -> Optional[BBox]:
        """Build a BBox helper from token coordinates."""
        tb = token.get("bbox")
        if not isinstance(tb, dict):
            return None
        try:
            return BBox(
                float(tb.get("x0", 0.0)),
                float(tb.get("y0", 0.0)),
                float(tb.get("x1", 0.0)),
                float(tb.get("y1", 0.0)),
            )
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _bbox_overlaps_band(bbox: BBox, band: Optional[Tuple[float, float]]) -> bool:
        """Check if bbox overlaps the supplied y band."""
        if band is None:
            return True
        y0, y1 = band
        return not (bbox.y1 < y0 or bbox.y0 > y1)

    def _filter_page_markers_for_page(
        self,
        page: int,
        page_tokens: List[Dict[str, Any]],
        raw_lines: Optional[List[Dict[str, Any]]],
        patterns: List[re.Pattern],
        y_band: Optional[Tuple[float, float]],
    ) -> Tuple[List[Dict[str, Any]], Optional[List[Dict[str, Any]]], List[BBox]]:
        """Remove footer-like page markers from tokens and lines for a page."""
        if not patterns:
            tokens_copy = list(page_tokens) if page_tokens else []
            lines_copy = list(raw_lines) if raw_lines is not None else None
            return tokens_copy, lines_copy, []

        tokens_copy = list(page_tokens) if page_tokens else []
        lines_copy = list(raw_lines) if raw_lines is not None else None
        removed_boxes: List[BBox] = []
        to_remove: Set[int] = set()

        # Row-level matching to capture multi-token markers.
        if tokens_copy:
            rows = self._group_rows_from_tokens(tokens_copy)
            for row in rows:
                if not row:
                    continue
                row_bbox = self._bbox_from_tokens(row)
                if not row_bbox or not self._bbox_overlaps_band(row_bbox, y_band):
                    continue

                row_text = " ".join(
                    (token.get("norm") or token.get("text") or "").strip()
                    for token in row
                ).strip()
                normalized_row_text = " ".join(row_text.split())
                if not normalized_row_text:
                    continue

                if any(pattern.search(normalized_row_text) for pattern in patterns):
                    removed_boxes.append(row_bbox)
                    for token in row:
                        to_remove.add(id(token))

        # Line-level matching when line information exists.
        if lines_copy is not None:
            filtered_lines: List[Dict[str, Any]] = []
            for line in lines_copy:
                text = str(line.get("text", "")).strip()
                if not text:
                    continue

                normalized_text = " ".join(text.split())
                raw_bbox = line.get("bbox")
                bbox_obj = None
                if isinstance(raw_bbox, dict):
                    try:
                        bbox_obj = BBox(
                            float(raw_bbox.get("x0", 0.0)),
                            float(raw_bbox.get("y0", 0.0)),
                            float(raw_bbox.get("x1", 0.0)),
                            float(raw_bbox.get("y1", 0.0)),
                        )
                    except (TypeError, ValueError):
                        bbox_obj = None

                if any(pattern.search(normalized_text) for pattern in patterns) and (
                    bbox_obj is None or self._bbox_overlaps_band(bbox_obj, y_band)
                ):
                    if bbox_obj is not None:
                        removed_boxes.append(bbox_obj)
                        for token in tokens_copy:
                            if self._token_intersects_bbox(token, bbox_obj, tol=0.0):
                                to_remove.add(id(token))
                    continue

                filtered_lines.append(line)

            lines_copy = filtered_lines

        # Token-level fallback matching for isolated tokens.
        for token in tokens_copy:
            if id(token) in to_remove:
                continue

            text = (token.get("norm") or token.get("text") or "").strip()
            if not text:
                continue
            normalized_text = " ".join(text.split())

            if any(pattern.search(normalized_text) for pattern in patterns):
                token_bbox = self._bbox_from_token(token)
                if token_bbox is None or self._bbox_overlaps_band(token_bbox, y_band):
                    if token_bbox is not None:
                        removed_boxes.append(token_bbox)
                    to_remove.add(id(token))

        if to_remove:
            filtered_tokens = [token for token in tokens_copy if id(token) not in to_remove]
        else:
            filtered_tokens = tokens_copy

        return filtered_tokens, lines_copy, removed_boxes

    def _filter_repeated_headers(
        self,
        walk: Sequence[int],
        toks_by_page: Dict[int, List[Dict[str, Any]]],
        local_lines_by_page: Dict[int, List[Dict[str, Any]]],
        source_lines_by_page: Optional[Dict[int, List[Dict[str, Any]]]],
        header_floor_by_page: Dict[int, Tuple[float, str]],
        header_defaults: Dict[str, Any],
        start_anchor_top: Optional[float],
    ) -> Dict[int, List[BBox]]:
        """Drop repeated header blocks on continuation pages and return their boxes."""
        header_boxes_by_page: Dict[int, List[BBox]] = {int(p): [] for p in walk}
        if not walk:
            return header_boxes_by_page

        whitelist_patterns = self._get_table_header_patterns()
        margin_px = float(header_defaults.get("margin_px", 0.0) or 0.0)
        seen_header_keys: Set[str] = set()

        for index, page in enumerate(walk):
            page_lines = local_lines_by_page.get(page, [])
            if not page_lines:
                continue

            header_floor, _ = header_floor_by_page.get(
                page,
                (float(header_defaults.get("ratio_top_fallback", 0.15) or 0.15), "default"),
            )
            band_limit = float(header_floor) + margin_px
            if start_anchor_top is not None:
                band_limit = max(band_limit, float(start_anchor_top) + margin_px)

            candidates: List[Dict[str, Any]] = []
            for line in page_lines:
                text = str(line.get("text", "")).strip()
                if not text:
                    continue
                if whitelist_patterns and any(pattern.search(text) for pattern in whitelist_patterns):
                    continue

                raw_bbox = line.get("bbox")
                if not isinstance(raw_bbox, dict):
                    continue
                try:
                    bbox = BBox(
                        float(raw_bbox.get("x0", 0.0)),
                        float(raw_bbox.get("y0", 0.0)),
                        float(raw_bbox.get("x1", 0.0)),
                        float(raw_bbox.get("y1", 0.0)),
                    )
                except (TypeError, ValueError):
                    continue

                if bbox.y1 > band_limit + 1e-6:
                    continue

                key = self._header_repetition_key(text)
                if not key:
                    continue

                candidates.append({
                    "line": line,
                    "bbox": bbox,
                    "key": key,
                })

            if not candidates:
                continue

            # First page in walk establishes reference texts but is not pruned
            if index == 0:
                for candidate in candidates:
                    seen_header_keys.add(candidate["key"])
                continue

            lines_to_remove: List[Dict[str, Any]] = []
            for candidate in candidates:
                key = candidate["key"]
                if key in seen_header_keys:
                    lines_to_remove.append(candidate)
                else:
                    seen_header_keys.add(key)

            if not lines_to_remove:
                continue

            removal_ids = {id(item["line"]) for item in lines_to_remove}
            header_boxes_by_page[page].extend(item["bbox"] for item in lines_to_remove)

            # Remove matching lines from local/source collections
            local_lines_by_page[page] = [
                line for line in page_lines
                if id(line) not in removal_ids
            ]

            if source_lines_by_page is not None and page in source_lines_by_page:
                source_lines_by_page[page] = [
                    line for line in source_lines_by_page.get(page, [])
                    if id(line) not in removal_ids
                ]

            # Remove intersecting tokens from this page
            page_tokens = toks_by_page.get(page, [])
            if not page_tokens:
                continue

            token_ids_to_drop: Set[int] = set()
            for item in lines_to_remove:
                bbox_obj = item["bbox"]
                for token in page_tokens:
                    if self._token_intersects_bbox(token, bbox_obj, tol=0.0):
                        token_ids_to_drop.add(id(token))

            if token_ids_to_drop:
                toks_by_page[page] = [
                    token for token in page_tokens
                    if id(token) not in token_ids_to_drop
                ]

        return header_boxes_by_page

    def _trim_bbox_with_markers(
        self,
        bbox_list: List[float],
        marker_boxes: List[BBox],
        precision: int,
    ) -> List[float]:
        """Trim the bottom of a bbox when exclusion boxes (markers/headers) overlap."""
        if not marker_boxes:
            return bbox_list

        bbox = BBox.from_list(bbox_list)
        new_y1 = bbox.y1

        for marker in marker_boxes:
            if marker.x1 <= bbox.x0 or marker.x0 >= bbox.x1:
                continue
            if marker.y0 >= new_y1 or marker.y1 <= bbox.y0:
                continue

            cutoff = max(marker.y0 - 0.002, bbox.y0)
            new_y1 = min(new_y1, cutoff)

        if new_y1 <= bbox.y0:
            new_y1 = min(bbox.y1, bbox.y0 + 1e-5)

        if abs(new_y1 - bbox.y1) > 1e-9:
            bbox.y1 = new_y1

        return bbox.to_list(precision)
    
    def _check_guard(self, tokens: List[Dict[str, Any]], patterns: List[str]) -> bool:
        """Check if page contains any of the guard patterns."""
        if not patterns:
            return True
        
        page_text = " ".join(t.get("norm", t.get("text", "")) for t in tokens).upper()
        
        for pattern in patterns:
            if pattern.upper() in page_text:
                return True
        
        return False
    
    def _detect_region(self, ctx: Context, region_config: Dict[str, Any]) -> Optional[DetectionResult]:
        """Detect a region using its mode chain."""
        mode_chain = ModeNormalizer.normalize_chain(region_config)
        
        if not mode_chain:
            logger.warning(f"No detection modes for region {region_config.get('id')}")
            return None
        
        # Try each mode in chain
        for mode_spec in mode_chain:
            mode_name = mode_spec.get("by")
            if not mode_name:
                logger.warning(f"Mode spec missing 'by' key: {mode_spec}")
                continue
            
            if mode_name not in self.mode_handlers:
                logger.warning(f"Unknown mode: {mode_name}")
                continue
            
            handler = self.mode_handlers[mode_name]
            
            try:
                result = handler(ctx, **mode_spec)
                if result:
                    return result
            except Exception as e:
                logger.warning(f"Mode {mode_name} failed: {e}")
        
        return None
    
    def _process_region(
        self,
        region_config: Dict[str, Any],
        pages: List[int],
        tokens: List[Dict[str, Any]],
        total_pages: int,
        lines_by_page: Optional[Dict[int, List[Dict[str, Any]]]] = None,
    ) -> List[Dict[str, Any]]:
        """Process a region across specified pages."""
        region_id = region_config["id"]
        keep_policy = region_config.get("keep", "all")

        logger.info(f"Begin region '{region_id}' on pages {pages[:5]}{'...' if len(pages) > 5 else ''}")

        # Cross-page anchors path (document scope) — optional and backward compatible
        detect_cfg = region_config.get("detect", {}) or {}
        detection_by = detect_cfg.get("by", "")
        is_anchors_mode = detection_by in ("anchors", "line_anchors")
        if is_anchors_mode:
            anchor_scope = str(detect_cfg.get("anchor_scope", "auto")).lower()
            max_gap_value = detect_cfg.get("max_page_gap", 1)
            max_gap = int(max_gap_value) if max_gap_value is not None else 999
            val_policy = str(detect_cfg.get("value_part_policy", "end")).lower()

            try_cross_page = False
            if anchor_scope == "document":
                try_cross_page = True
            elif anchor_scope == "auto" and detect_cfg.get("end_anchor") is not None:
                # Heuristic: if a start anchor is found on some page but end is missing on same page
                # then we attempt cross-page detection. Only applies when end_anchor is configured.
                start_spec = detect_cfg.get("start_anchor")
                end_spec = detect_cfg.get("end_anchor")
                if start_spec and end_spec:
                    for p in pages:
                        page_tokens = [t for t in tokens if t.get("page") == p]
                        sm = AnchorMatcher.match(page_tokens, start_spec)
                        if sm:
                            em = AnchorMatcher.match(page_tokens, end_spec, sm)
                            if not em:
                                try_cross_page = True
                            break

            if try_cross_page:
                cross = self._detect_anchors_cross_page(
                    region_config=region_config,
                    pages=pages,
                    tokens=tokens,
                    total_pages=total_pages,
                    lines_by_page=lines_by_page
                )
                if cross:
                    logger.info(f"End region '{region_id}': cross-page anchors canonical emitted")
                    return [cross]

        # Collect results from all pages
        page_results = []
        
        for page in pages:
            # Check guard condition
            if "only_if_contains" in region_config:
                page_tokens = [t for t in tokens if t["page"] == page]
                if not self._check_guard(page_tokens, region_config["only_if_contains"]):
                    continue
            
            # Process this page
            segment = self._process_region_on_page(
                region_config,
                page,
                tokens,
                total_pages,
                lines_by_page=lines_by_page,
            )
            if segment:
                page_results.append(segment)
        
        # Apply keep policy
        if not page_results:
            logger.info(f"End region '{region_id}': no results")
            return []
        
        if keep_policy == "first":
            results = [page_results[0]]
            logger.info(f"End region '{region_id}': keeping first (page {results[0]['page']})")
        elif keep_policy == "last":
            results = [page_results[-1]]
            logger.info(f"End region '{region_id}': keeping last (page {results[0]['page']})")
        else:  # "all"
            results = page_results
            logger.info(f"End region '{region_id}': keeping all ({len(results)} pages)")
        
        return results
    
    def _process_region_on_page(
        self,
        region_config: Dict[str, Any],
        page: int,
        tokens: List[Dict[str, Any]],
        total_pages: int,
        parent_bbox: Optional[BBox] = None,
        lines_by_page: Optional[Dict[int, List[Dict[str, Any]]]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Process a single region on a specific page."""
        region_id = region_config["id"]

        # Prepare tokens scoped to the optional parent bbox
        page_tokens = [t for t in tokens if t["page"] == page]
        if parent_bbox:
            tol = self.config.get("tolerances", {}).get("parent_overlap_tol", 0.0)
            page_tokens = [
                t for t in page_tokens
                if self._token_intersects_bbox(t, parent_bbox, tol)
            ]

        raw_lines = None
        if lines_by_page is not None:
            raw_lines = list(lines_by_page.get(page, []) or [])

        drop_markers = self._should_drop_page_markers(region_config)
        if drop_markers:
            marker_patterns = self._get_marker_patterns(region_config)
            if marker_patterns:
                marker_band = self._get_marker_y_band(region_config)
                filtered_tokens, filtered_lines, _ = self._filter_page_markers_for_page(
                    page,
                    page_tokens,
                    raw_lines,
                    marker_patterns,
                    marker_band,
                )
                page_tokens = filtered_tokens
                if raw_lines is not None:
                    raw_lines = filtered_lines or []

        # Group tokens into rows
        rows = self._group_rows_from_tokens(page_tokens)

        # Prepare line records if available
        page_lines, lines_available = self._build_line_records(
            page=page,
            page_tokens=page_tokens,
            rows=rows,
            raw_lines=raw_lines,
        )

        # Build context with defaults
        ctx = Context(
            page=page,
            total_pages=total_pages,
            tokens=page_tokens,
            rows=rows,
            table_provider=self.table_provider,
            config=self.config,
            logger=logger,
            parent_bbox=parent_bbox,
            defaults=self.config.get("defaults", {}),
            lines=page_lines,
            lines_available=lines_available,
        )
        
        # Detect region
        result = self._detect_region(ctx, region_config)
        if not result:
            return None
        
        # Build segment
        segment = {
            "id": region_id,
            "type": "region",
            "page": page,
            "bbox": result.bbox.to_list(self.config.get("coords", {}).get("precision", 6)),
            "label": region_config.get("label", region_id),
        }
        
        # Add metadata
        if result.metadata:
            segment["metadata"] = result.metadata
        
        return segment
    
    def segment_page_with_dependencies(
        self,
        regions: List[Dict[str, Any]],
        page: int,
        tokens: List[Dict[str, Any]],
        total_pages: int,
        lines_by_page: Optional[Dict[int, List[Dict[str, Any]]]] = None,
    ) -> List[Dict[str, Any]]:
        """Process regions on a page with dependency resolution."""
        segments = []
        parent_results = {}  # region_id -> DetectionResult
        
        # Process in dependency order
        for region_config in regions:
            region_id = region_config["id"]
            
            # Check if parent exists and was found
            inside = region_config.get("inside")
            parent_bbox = None
            
            if inside:
                parent_id = inside.lstrip("@")
                if parent_id not in parent_results:
                    logger.debug(f"Skipping region '{region_id}' on page {page}: parent '{parent_id}' not found")
                    continue
                parent_bbox = parent_results[parent_id].bbox
            
            # Process region
            segment = self._process_region_on_page(
                region_config,
                page,
                tokens,
                total_pages,
                parent_bbox,
                lines_by_page=lines_by_page,
            )
            if not segment:
                continue
            
            # Clip to parent if needed
            if parent_bbox:
                original_bbox = BBox.from_list(segment["bbox"])
                clipped_bbox = original_bbox.clip_to(parent_bbox)
                segment["bbox"] = clipped_bbox.to_list(self.config.get("coords", {}).get("precision", 6))
                logger.debug(f"Clipped region '{region_id}' to parent bounds")
            
            # Store result for child dependencies
            parent_results[region_id] = DetectionResult(
                bbox=BBox.from_list(segment["bbox"]),
                metadata=segment.get("metadata", {})
            )
            
            segments.append(segment)
        
        return segments
    
    def segment(
        self,
        in_path: Path,
        out_path: Path,
        tokenizer: str,
        overlay_pdf: Optional[Path] = None,
    ) -> Dict[str, Any]:
        """Main segmentation entry point."""
        # Load input
        data = json.loads(in_path.read_text(encoding="utf-8"))

        engine_block = data.get(tokenizer)
        if not isinstance(engine_block, dict) or not isinstance(engine_block.get("tokens"), list):
            raise SystemExit(f"Tokenizer '{tokenizer}' tokens not found in input JSON")

        tokens = engine_block["tokens"]
        lines = engine_block.get("lines")
        lines_by_page: Optional[Dict[int, List[Dict[str, Any]]]] = None
        if isinstance(lines, list):
            lines_by_page = {}
            for line in lines:
                try:
                    page_idx = int(line.get("page"))
                except (TypeError, ValueError):
                    continue
                lines_by_page.setdefault(page_idx, []).append(line)
        page_count = data.get("page_count", 0)
        
        # Resolve region dependencies
        regions = self.config.get("regions", [])
        ordered_regions = DependencyResolver.resolve_order(regions)
        
        # Group regions by dependency level for efficient processing
        # Root regions can use keep policy across pages
        # Child regions must be processed per-page with their parents
        
        root_regions = [r for r in ordered_regions if not r.get("inside")]
        child_regions = [r for r in ordered_regions if r.get("inside")]
        
        all_segments = []
        
        # Process root regions with keep policy
        for region_config in root_regions:
            on_pages = region_config.get("on_pages", "all")
            pages = PageResolver.resolve(on_pages, page_count)
            
            if pages:
                segments = self._process_region(
                    region_config,
                    pages,
                    tokens,
                    page_count,
                    lines_by_page=lines_by_page,
                )
                all_segments.extend(segments)
        
        # Process child regions page by page with dependencies
        if child_regions:
            for page in range(1, page_count + 1):
                # Filter regions that apply to this page
                page_regions = []
                for region_config in child_regions:
                    on_pages = region_config.get("on_pages", "all")
                    if page in PageResolver.resolve(on_pages, page_count):
                        page_regions.append(region_config)
                
                if page_regions:
                    # Include root regions for this page as potential parents
                    all_page_regions = []
                    for r in root_regions:
                        on_pages = r.get("on_pages", "all")
                        if page in PageResolver.resolve(on_pages, page_count):
                            all_page_regions.append(r)
                    all_page_regions.extend(page_regions)
                    
                    segments = self.segment_page_with_dependencies(
                        all_page_regions,
                        page,
                        tokens,
                        page_count,
                        lines_by_page=lines_by_page,
                    )
                    
                    # Filter to only child segments (parents already added)
                    child_segments = [s for s in segments if s["id"] in {r["id"] for r in page_regions}]
                    all_segments.extend(child_segments)

        # Post-process: stitch multi-page fragments when configured/eligible
        all_segments = self._stitch_fragments(all_segments)
        
        # Build output
        output = {
            "schema_version": "s3.v3",
            "coords": self.config.get("coords", {
                "normalized": True,
                "y_origin": "top",
                "precision": 6
            }),
            "segments": all_segments,
            "policies": self.config.get("policies", {
                "stay_within_parent": True,
                "allow_overlap_in_parent": True
            }),
            "meta": {
                "doc_id": data.get("doc_id"),
                "page_count": page_count,
                "stage": "segmenter",
                "config_name": self.config.get("name", "Unknown"),
                "version": "3.1"
            }
        }
        
        # Save output
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(output, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8"
        )
        
        # Generate overlay if requested
        if overlay_pdf and PDF_OVERLAY_AVAILABLE:
            self._generate_overlay(output, overlay_pdf)
        
        # Print summary
        logger.info(json.dumps({
            "stage": "segmenter",
            "doc_id": output["meta"]["doc_id"],
            "total_segments": len(all_segments),
            "pages_processed": page_count,
            "config": self.config.get("name"),
            "tokenizer": tokenizer,
            "output": str(out_path)
        }, indent=2))
        
        return output

    # ---------------------------------------------------------------------
    # Cross-page Anchors (document scope)
    # ---------------------------------------------------------------------

    def _detect_header_floor(self,
                            page_lines: List[Dict[str, Any]],
                            config: Dict[str, Any]) -> Tuple[float, str]:
        """
        Detect page header floor using sentinels or ratio fallback.

        Returns: (header_floor_y, detection_method)
        """
        header_detection = config.get("header_detection", {})
        sentinels = header_detection.get("sentinels", [])
        ratio_fallback = header_detection.get("ratio_top_fallback", 0.15)
        margin_px = header_detection.get("margin_px", 0.01)

        # Try sentinels first
        if sentinels:
            for line in page_lines:
                text = str(line.get("text", "")).strip()
                for pattern in sentinels:
                    try:
                        if re.search(pattern, text, re.IGNORECASE):
                            bbox = line.get("bbox")
                            if bbox:
                                if isinstance(bbox, dict):
                                    y1 = float(bbox.get("y1", 0))
                                else:
                                    y1 = float(bbox[3])
                                return y1 + margin_px, "sentinel"
                    except re.error:
                        logger.warning(f"Invalid sentinel regex: {pattern}")

        # Fallback to ratio
        return ratio_fallback, "ratio_fallback"

    def _detect_repeated_table_header(self,
                                      page_lines: List[Dict[str, Any]],
                                      header_floor: float,
                                      config: Dict[str, Any]) -> Optional[float]:
        """
        Detect repeated table header on continuation pages.

        Returns: y1 of the repeated header, or None if not found
        """
        table_header_detection = config.get("table_header_detection", {})
        patterns = table_header_detection.get("patterns", [])
        search_band_ratio = table_header_detection.get("search_band_ratio", 0.15)

        if not patterns:
            return None

        search_top = header_floor
        search_bottom = header_floor + search_band_ratio

        for line in page_lines:
            text = str(line.get("text", "")).strip()
            bbox = line.get("bbox")
            if not bbox:
                continue

            if isinstance(bbox, dict):
                y0 = float(bbox.get("y0", 0))
                y1 = float(bbox.get("y1", 0))
            else:
                y0 = float(bbox[1])
                y1 = float(bbox[3])

            # Check if line is within search band
            if y0 < search_top or y1 > search_bottom:
                continue

            # Check if line matches any table header pattern
            for pattern in patterns:
                try:
                    if re.search(pattern, text, re.IGNORECASE):
                        return y1
                except re.error:
                    logger.warning(f"Invalid table header regex: {pattern}")

        return None

    def _find_first_data_row(self,
                            page_tokens: List[Dict[str, Any]],
                            top_y: float,
                            config: Dict[str, Any]) -> Optional[float]:
        """
        Find the first data row that matches row patterns and has numeric content.

        Returns: y0 of the first data row, or None
        """
        row_patterns = config.get("row_patterns", [])
        numeric_locale = config.get("numeric_locale", {"thousands": ",", "decimal": "."})

        if not row_patterns:
            return None

        # Group tokens into rows
        rows = []
        current_row = []
        last_y = None
        y_tol = 0.01

        for token in sorted(page_tokens, key=lambda t: (t["bbox"]["y0"], t["bbox"]["x0"])):
            ty0 = float(token["bbox"]["y0"])

            if ty0 < top_y:
                continue

            if last_y is None or abs(ty0 - last_y) < y_tol:
                current_row.append(token)
                last_y = ty0
            else:
                if current_row:
                    rows.append(current_row)
                current_row = [token]
                last_y = ty0

        if current_row:
            rows.append(current_row)

        # Find first row matching patterns with numeric content
        thousands = re.escape(numeric_locale.get("thousands", ","))
        decimal = re.escape(numeric_locale.get("decimal", "."))
        numeric_regex = re.compile(rf"\d{{1,3}}(?:{thousands}\d{{3}})*(?:{decimal}\d+)?")

        for row in rows:
            row_text = " ".join(t.get("norm", t.get("text", "")) for t in row)

            # Check if row matches any pattern
            matches_pattern = False
            for pattern in row_patterns:
                try:
                    if re.search(pattern, row_text):
                        matches_pattern = True
                        break
                except re.error:
                    logger.warning(f"Invalid row pattern: {pattern}")

            # Check if row has numeric content
            has_numeric = bool(numeric_regex.search(row_text))

            if matches_pattern and has_numeric:
                return min(float(t["bbox"]["y0"]) for t in row)

        return None

    def _count_data_rows(self,
                        page_tokens: List[Dict[str, Any]],
                        bbox: List[float],
                        config: Dict[str, Any]) -> int:
        """
        Count rows that look like data rows (match row patterns and have numeric content).
        """
        row_patterns = config.get("row_patterns", [])
        numeric_locale = config.get("numeric_locale", {"thousands": ",", "decimal": "."})

        # Filter tokens within bbox
        bx0, by0, bx1, by1 = bbox
        filtered_tokens = []
        for t in page_tokens:
            tx0 = float(t["bbox"]["x0"])
            ty0 = float(t["bbox"]["y0"])
            tx1 = float(t["bbox"]["x1"])
            ty1 = float(t["bbox"]["y1"])

            if tx1 > bx0 and tx0 < bx1 and ty1 > by0 and ty0 < by1:
                filtered_tokens.append(t)

        if not filtered_tokens:
            return 0

        # Group into rows
        rows = []
        current_row = []
        last_y = None
        y_tol = 0.01

        for token in sorted(filtered_tokens, key=lambda t: (t["bbox"]["y0"], t["bbox"]["x0"])):
            ty0 = float(token["bbox"]["y0"])

            if last_y is None or abs(ty0 - last_y) < y_tol:
                current_row.append(token)
                last_y = ty0
            else:
                if current_row:
                    rows.append(current_row)
                current_row = [token]
                last_y = ty0

        if current_row:
            rows.append(current_row)

        # Count rows matching criteria
        thousands = re.escape(numeric_locale.get("thousands", ","))
        decimal = re.escape(numeric_locale.get("decimal", "."))
        numeric_regex = re.compile(rf"\d{{1,3}}(?:{thousands}\d{{3}})*(?:{decimal}\d+)?")

        count = 0
        for row in rows:
            row_text = " ".join(t.get("norm", t.get("text", "")) for t in row)

            # Check pattern match
            matches_pattern = False
            if row_patterns:
                for pattern in row_patterns:
                    try:
                        if re.search(pattern, row_text):
                            matches_pattern = True
                            break
                    except re.error:
                        pass
            else:
                matches_pattern = True  # If no patterns, count all numeric rows

            # Check numeric content
            has_numeric = bool(numeric_regex.search(row_text))

            if matches_pattern and has_numeric:
                count += 1

        return count

    def _detect_anchors_cross_page(self,
                                   region_config: Dict[str, Any],
                                   pages: List[int],
                                   tokens: List[Dict[str, Any]],
                                   total_pages: int,
                                   lines_by_page: Optional[Dict[int, List[Dict[str, Any]]]] = None) -> Optional[Dict[str, Any]]:
        """
        Document-scope anchor detector:
          - Finds start_anchor on some page N.
          - If end_anchor exists, search page N..N+max_page_gap for the first end.
          - Build per-page slices (parts) using region-level margins.
          - Choose the "value" part by policy and return ONE canonical segment.
        """
        detect = region_config.get("detect", {}) or {}
        start_spec = detect.get("start_anchor")
        end_spec = detect.get("end_anchor")
        if not start_spec:
            return None

        # Config knobs with defaults
        anchor_scope = str(detect.get("anchor_scope", "auto")).lower()
        max_page_gap_value = detect.get("max_page_gap", 1)
        max_page_gap = int(max_page_gap_value) if max_page_gap_value is not None else 999
        value_part_policy = str(detect.get("value_part_policy", "end")).lower()
        canonical_bbox_mode = str(detect.get("canonical_bbox", "value")).lower()  # "value"|"union"

        # Margins and horizontal/row policy
        defaults = self.config.get("defaults", {}) or {}
        header_defaults = defaults.get("header_detection", {}) or {}
        margin_cfg = detect.get("margin", {}) or {}
        mt = float(margin_cfg.get("top", 0.0))
        mb = float(margin_cfg.get("bottom", 0.0))
        ml = float(margin_cfg.get("left", 0.0))
        mr = float(margin_cfg.get("right", 0.0))
        min_h = float(defaults.get("min_height", 0.0))

        x_policy = str(detect.get("x_policy", "full")).lower()
        pad_left = float(detect.get("pad_left", 0.0))
        pad_right = float(detect.get("pad_right", 0.0))

        # Row selection controls (optional)
        start_rows_above = int(detect.get("start_rows_above", 0))
        start_rows_below = int(detect.get("start_rows_below", 0))
        end_rows_above = int(detect.get("end_rows_above", 0))
        end_rows_below = int(detect.get("end_rows_below", 0))
        row_tol = float(detect.get("row_tol", self.config.get("tolerances", {}).get("y_line_tol", 0.006)))
        row_safety = float(detect.get("row_safety", 0.003))

        # Token index by page
        toks_by_page: Dict[int, List[Dict[str, Any]]] = {}
        for t in tokens:
            p = int(t.get("page", 0) or 0)
            if p in pages:
                toks_by_page.setdefault(p, []).append(t)

        for p in pages:
            toks_by_page.setdefault(p, [])

        marker_boxes_by_page: Dict[int, List[BBox]] = {p: [] for p in pages}
        filtered_input_lines_by_page: Dict[int, List[Dict[str, Any]]] = {}

        drop_markers = self._should_drop_page_markers(region_config)
        marker_patterns = self._get_marker_patterns(region_config) if drop_markers else []
        marker_band = self._get_marker_y_band(region_config) if marker_patterns else None

        for p in pages:
            page_tokens = toks_by_page.get(p, [])
            page_lines = list(lines_by_page.get(p, []) or []) if lines_by_page is not None else None

            if marker_patterns:
                filtered_tokens, filtered_lines, removed_boxes = self._filter_page_markers_for_page(
                    p,
                    page_tokens,
                    page_lines,
                    marker_patterns,
                    marker_band,
                )
                toks_by_page[p] = filtered_tokens
                marker_boxes_by_page[p] = removed_boxes
                if page_lines is not None:
                    filtered_input_lines_by_page[p] = filtered_lines or []
            else:
                if page_lines is not None:
                    filtered_input_lines_by_page[p] = page_lines

        # Build lines by page for header floor detection
        # Check if we have skip_page_headers or use_per_page_header_floors configured
        skip_page_headers = detect.get("skip_page_headers", False)
        use_per_page_header_floors = detect.get("use_per_page_header_floors", False)

        local_lines_by_page: Dict[int, List[Dict[str, Any]]] = {}
        header_floor_by_page: Dict[int, Tuple[float, str]] = {}
        source_lines_by_page: Optional[Dict[int, List[Dict[str, Any]]]] = None
        if lines_by_page is not None:
            source_lines_by_page = filtered_input_lines_by_page

        if skip_page_headers or use_per_page_header_floors:
            # Use provided lines_by_page if available AND if they have valid bboxes
            use_existing_lines = False
            if source_lines_by_page:
                # Check if lines have valid bboxes
                for p in pages:
                    page_lines = source_lines_by_page.get(p, [])
                    if page_lines:
                        # Check if first line has a valid bbox
                        first_bbox = page_lines[0].get("bbox", {})
                        if isinstance(first_bbox, dict) and "y0" in first_bbox and "y1" in first_bbox:
                            use_existing_lines = True
                            break

            if use_existing_lines and source_lines_by_page:
                # Use existing lines from s02
                for p in pages:
                    page_lines = source_lines_by_page.get(p, [])
                    local_lines_by_page[p] = page_lines
                    if page_lines:
                        header_floor_by_page[p] = self._detect_header_floor(page_lines, defaults)
                    else:
                        header_floor_by_page[p] = (defaults.get("header_detection", {}).get("ratio_top_fallback", 0.15), "default")
            else:
                # Fallback: construct pseudo-lines from tokens grouped by y-coordinate
                for p in pages:
                    page_toks = toks_by_page.get(p, [])
                    if not page_toks:
                        local_lines_by_page[p] = []
                        header_floor_by_page[p] = (defaults.get("header_detection", {}).get("ratio_top_fallback", 0.15), "default")
                        continue

                    # Group tokens into lines
                    line_groups = []
                    current_line = []
                    last_y = None
                    y_tol = 0.005

                    for tok in sorted(page_toks, key=lambda t: (t["bbox"]["y0"], t["bbox"]["x0"])):
                        ty0 = float(tok["bbox"]["y0"])
                        if last_y is None or abs(ty0 - last_y) < y_tol:
                            current_line.append(tok)
                            last_y = ty0
                        else:
                            if current_line:
                                line_groups.append(current_line)
                            current_line = [tok]
                            last_y = ty0

                    if current_line:
                        line_groups.append(current_line)

                    # Convert to line objects
                    page_lines = []
                    for line_tokens in line_groups:
                        text = " ".join(t.get("norm", t.get("text", "")) for t in line_tokens)
                        x0 = min(float(t["bbox"]["x0"]) for t in line_tokens)
                        y0 = min(float(t["bbox"]["y0"]) for t in line_tokens)
                        x1 = max(float(t["bbox"]["x1"]) for t in line_tokens)
                        y1 = max(float(t["bbox"]["y1"]) for t in line_tokens)
                        page_lines.append({
                            "text": text,
                            "bbox": {"x0": x0, "y0": y0, "x1": x1, "y1": y1}
                        })

                    local_lines_by_page[p] = page_lines

                    # Detect header floor for this page
                    header_floor_by_page[p] = self._detect_header_floor(page_lines, defaults)

        # For line_anchors mode, convert lines to pseudo-tokens for AnchorMatcher
        # Create pseudo-tokens from constructed lines
        lines_as_tokens_by_page: Dict[int, List[Dict[str, Any]]] = {}
        if local_lines_by_page:
            for p, page_lines in local_lines_by_page.items():
                pseudo_tokens = []
                for line in page_lines:
                    text = line.get("text", "")
                    bbox = line.get("bbox", {})
                    if text and bbox and isinstance(bbox, dict):
                        pseudo_tokens.append({
                            "text": text,
                            "norm": text,
                            "page": p,
                            "bbox": bbox
                        })
                lines_as_tokens_by_page[p] = pseudo_tokens

        # Find start anchor on candidate pages in order
        start_page = None
        start_match = None
        for p in pages:
            # Use line-based pseudo-tokens if available, otherwise use regular tokens
            search_items = lines_as_tokens_by_page.get(p, []) if lines_as_tokens_by_page else toks_by_page.get(p, [])
            if not search_items:
                continue
            sm = AnchorMatcher.match(search_items, start_spec)
            if sm:
                start_page = p
                start_match = sm
                break

        if not start_match or start_page is None:
            return None

        # Find end anchor, same page first then forward up to max_page_gap
        end_page = None
        end_match = None
        if end_spec:
            # same page
            search_items = lines_as_tokens_by_page.get(start_page, []) if lines_as_tokens_by_page else toks_by_page.get(start_page, [])
            em = AnchorMatcher.match(search_items, end_spec, start_match)
            if em:
                end_page, end_match = start_page, em
            else:
                # forward search
                # Build a restricted list of pages after start_page within gap
                try:
                    idx = pages.index(start_page)
                except ValueError:
                    idx = 0
                lookahead = [p for p in pages[idx+1:] if (p - start_page) <= max_page_gap]
                for p in lookahead:
                    search_items = lines_as_tokens_by_page.get(p, []) if lines_as_tokens_by_page else toks_by_page.get(p, [])
                    em2 = AnchorMatcher.match(search_items, end_spec)
                    if em2:
                        end_page, end_match = p, em2
                        break

        # Fallback closing if no end anchor
        if end_page is None:
            # Last page in scope
            end_page = pages[-1]
            # Try y_cutoff fallback if present, prefer a 'top' cutoff
            cutoff_y = None
            for fb in (region_config.get("fallbacks") or []):
                fb = fb or {}
                by = fb.get("by") or fb.get("detect")
                if isinstance(by, dict):
                    by = by.get("by")
                if by == "y_cutoff":
                    edge = fb.get("edge", "top")
                    y = fb.get("y")
                    if y is None:
                        continue
                    if edge == "top" and cutoff_y is None:
                        cutoff_y = float(y)
                        break
                    if cutoff_y is None and edge == "bottom":
                        cutoff_y = float(y)
            # If still missing, close at bottom of page
            if cutoff_y is None:
                cutoff_y = 1.0

        # Respect guards on start/end pages if configured
        guard_patterns = region_config.get("only_if_contains") or []
        if guard_patterns:
            if not self._check_guard(toks_by_page.get(start_page, []), guard_patterns):
                return None
            if end_page != start_page and not self._check_guard(toks_by_page.get(end_page, []), guard_patterns):
                return None

        # Build page slices parts
        precision = self.config.get("coords", {}).get("precision", 6)
        parts: List[Dict[str, Any]] = []

        # Determine x policy base then apply left/right margins as expansion
        if x_policy == "anchor":
            base_x0 = max(0.0, float(start_match["bbox"][0]) - pad_left)
            base_x1 = min(1.0, float(start_match["bbox"][2]) + pad_right)
        else:  # "full" or unknown
            base_x0, base_x1 = 0.0, 1.0

        x0_fixed = max(0.0, base_x0 - ml)
        x1_fixed = min(1.0, base_x1 + mr)

        def _clamp_bbox(x0: float, y0: float, x1: float, y1: float) -> List[float]:
            b = BBox(x0, y0, x1, y1)
            if min_h > 0 and (b.y1 - b.y0) < min_h:
                b.y1 = min(1.0, b.y0 + min_h)
            return b.to_list(precision)

        # Iterate pages from start_page to end_page inclusive
        if start_page > end_page:
            return None

        # Map page numbers range using given pages order subset
        try:
            start_idx = pages.index(start_page)
            end_idx = pages.index(end_page)
        except ValueError:
            return None

        walk = pages[start_idx:end_idx+1]

        start_anchor_top: Optional[float] = None
        if start_match:
            try:
                start_anchor_top = float(start_match["bbox"][1])
            except (KeyError, TypeError, ValueError):
                start_anchor_top = None

        if skip_page_headers and walk:
            header_boxes_subset = self._filter_repeated_headers(
                walk=walk,
                toks_by_page=toks_by_page,
                local_lines_by_page=local_lines_by_page,
                source_lines_by_page=source_lines_by_page,
                header_floor_by_page=header_floor_by_page,
                header_defaults=header_defaults,
                start_anchor_top=start_anchor_top,
            )
            for pg, boxes in header_boxes_subset.items():
                if not boxes:
                    continue
                marker_boxes_by_page.setdefault(pg, [])
                marker_boxes_by_page[pg].extend(boxes)

            # Rebuild line pseudo tokens for pages that changed
            if local_lines_by_page:
                for pg in walk:
                    page_lines = local_lines_by_page.get(pg, [])
                    pseudo_tokens = []
                    for line in page_lines:
                        text = line.get("text", "")
                        bbox = line.get("bbox", {})
                        if text and bbox and isinstance(bbox, dict):
                            pseudo_tokens.append({
                                "text": text,
                                "norm": text,
                                "page": pg,
                                "bbox": bbox
                            })
                    lines_as_tokens_by_page[pg] = pseudo_tokens

        # Build row maps per page using potentially filtered tokens
        rows_by_page: Dict[int, List[List[Dict[str, Any]]]] = {}
        row_bounds_by_page: Dict[int, List[Tuple[float, float]]] = {}
        for p in pages:
            rows = self._group_rows_from_tokens(toks_by_page.get(p, []))
            rows_by_page[p] = rows
            bounds = []
            for r in rows:
                if not r:
                    continue
                y0 = min(float(t["bbox"]["y0"]) for t in r)
                y1 = max(float(t["bbox"]["y1"]) for t in r)
                bounds.append((y0, y1))
            row_bounds_by_page[p] = bounds

        # Helper to find the row index containing the anchor (by center y)
        def _row_index_for_anchor(page: int, anchor_bbox: List[float]) -> int:
            bounds = row_bounds_by_page.get(page) or []
            if not bounds:
                return -1
            ay0, ay1 = float(anchor_bbox[1]), float(anchor_bbox[3])
            ac = 0.5 * (ay0 + ay1)
            # choose row whose [y0,y1] contains ac, else nearest by center distance
            best_i, best_d = 0, float("inf")
            for i, (y0, y1) in enumerate(bounds):
                if y0 <= ac <= y1:
                    return i
                yc = 0.5 * (y0 + y1)
                d = abs(ac - yc)
                if d < best_d:
                    best_d, best_i = d, i
            return best_i

        # Track debug info per part
        parts_debug_info = []

        for i, p in enumerate(walk):
            # Initialize debug info for this part
            part_debug = {
                "page": p,
                "header_floor": None,
                "header_floor_method": None,
                "repeated_table_header_found": False,
                "first_data_row_y": None,
                "continuation_strategy": None
            }

            # Get header floor for this page if available
            page_header_floor = None
            header_method = None
            if use_per_page_header_floors and p in header_floor_by_page:
                page_header_floor, header_method = header_floor_by_page[p]
                part_debug["header_floor"] = page_header_floor
                part_debug["header_floor_method"] = header_method

            if p == start_page and p == end_page:
                # Single-page case: use exact start..end bounds
                # Apply header floor if configured
                if page_header_floor is not None:
                    sy0 = max(page_header_floor, float(start_match["bbox"][1]) + mt)
                elif (start_rows_above or start_rows_below or end_rows_above or end_rows_below) and row_bounds_by_page.get(p):
                    ai = _row_index_for_anchor(p, start_match["bbox"]) if start_match else -1
                    ei = _row_index_for_anchor(p, end_match["bbox"]) if end_match else ai
                    bounds = row_bounds_by_page.get(p) or []
                    if bounds:
                        lo = max(0, min(ai, ei) - max(0, start_rows_above))
                        hi = min(len(bounds) - 1, max(ai + start_rows_below, ei + end_rows_below))
                        sy0 = bounds[lo][0] - row_safety
                        ey1 = bounds[hi][1] + row_safety
                    else:
                        sy0 = float(start_match["bbox"][1]) - mt
                        ey1 = float((end_match or start_match)["bbox"][3]) + mb
                else:
                    sy0 = float(start_match["bbox"][1]) - mt
                    ey1 = float((end_match or start_match)["bbox"][3]) + mb

                if 'ey1' not in locals():
                    ey1 = float((end_match or start_match)["bbox"][3]) + mb

                bbox = _clamp_bbox(x0_fixed, max(0.0, sy0), x1_fixed, min(1.0, ey1))
                part_debug["continuation_strategy"] = "single_page"

            elif p == start_page:
                # Start page: use header floor as minimum, then start anchor
                if page_header_floor is not None:
                    sy0 = max(page_header_floor, float(start_match["bbox"][1]) + mt)
                elif (start_rows_above or start_rows_below) and row_bounds_by_page.get(p):
                    ai = _row_index_for_anchor(p, start_match["bbox"]) if start_match else -1
                    bounds = row_bounds_by_page.get(p) or []
                    if bounds and ai >= 0:
                        lo = max(0, ai - max(0, start_rows_above))
                        hi = min(len(bounds) - 1, ai + max(0, start_rows_below))
                        sy0 = bounds[lo][0] - row_safety
                    else:
                        sy0 = float(start_match["bbox"][1]) - mt
                else:
                    sy0 = float(start_match["bbox"][1]) - mt

                bbox = _clamp_bbox(x0_fixed, max(0.0, sy0), x1_fixed, 1.0 - mb)
                part_debug["continuation_strategy"] = "start_page"

            elif p == end_page:
                # End page: start from header floor (or top margin)
                # Then try to find content start
                if page_header_floor is not None:
                    top_y = page_header_floor
                else:
                    top_y = mt

                # On end page with skip_page_headers, try to skip repeated table header
                if skip_page_headers and p in local_lines_by_page:
                    repeated_header_y = self._detect_repeated_table_header(
                        local_lines_by_page[p], top_y, defaults
                    )
                    if repeated_header_y is not None:
                        top_y = repeated_header_y + 0.01
                        part_debug["repeated_table_header_found"] = True
                        part_debug["continuation_strategy"] = "skip_repeated_header"

                # If no repeated header found, try to find first data row
                if not part_debug["repeated_table_header_found"]:
                    first_row_y = self._find_first_data_row(toks_by_page.get(p, []), top_y, defaults)
                    if first_row_y is not None:
                        top_y = first_row_y
                        part_debug["first_data_row_y"] = first_row_y
                        part_debug["continuation_strategy"] = "first_data_row"

                # Bottom bound
                if (end_rows_above or end_rows_below) and row_bounds_by_page.get(p):
                    ei = _row_index_for_anchor(p, (end_match or start_match)["bbox"]) if (end_match or start_match) else -1
                    bounds = row_bounds_by_page.get(p) or []
                    if bounds and ei >= 0:
                        lo = max(0, ei - max(0, end_rows_above))
                        hi = min(len(bounds) - 1, ei + max(0, end_rows_below))
                        ey1 = bounds[hi][1] + row_safety
                    else:
                        if end_match is not None:
                            ey1 = float(end_match["bbox"][3]) + mb
                        else:
                            ey1 = float(cutoff_y)
                else:
                    if end_match is not None:
                        ey1 = float(end_match["bbox"][3]) + mb
                    else:
                        ey1 = float(cutoff_y)

                bbox = _clamp_bbox(x0_fixed, max(0.0, top_y), x1_fixed, min(1.0, ey1))

            else:
                # Middle/continuation page
                if page_header_floor is not None:
                    top_y = page_header_floor
                else:
                    top_y = mt

                # Try to skip repeated table header on continuation pages
                if skip_page_headers and p in local_lines_by_page:
                    repeated_header_y = self._detect_repeated_table_header(
                        local_lines_by_page[p], top_y, defaults
                    )
                    if repeated_header_y is not None:
                        top_y = repeated_header_y + 0.01
                        part_debug["repeated_table_header_found"] = True
                        part_debug["continuation_strategy"] = "skip_repeated_header"

                # If no repeated header, try to find first data row
                if not part_debug["repeated_table_header_found"]:
                    first_row_y = self._find_first_data_row(toks_by_page.get(p, []), top_y, defaults)
                    if first_row_y is not None:
                        top_y = first_row_y
                        part_debug["first_data_row_y"] = first_row_y
                        part_debug["continuation_strategy"] = "first_data_row"
                    else:
                        part_debug["continuation_strategy"] = "default_from_header_floor"

                bbox = _clamp_bbox(x0_fixed, max(0.0, top_y), x1_fixed, 1.0 - mb)

            trim_boxes = marker_boxes_by_page.get(p, [])
            trimmed_bbox = self._trim_bbox_with_markers(
                bbox,
                trim_boxes,
                precision,
            )
            part_debug["page_marker_trimmed"] = trimmed_bbox != bbox
            bbox = trimmed_bbox

            parts.append({
                "id": f"{region_config['id']}__p{i+1}",
                "page": int(p),
                "bbox": bbox,
                "metadata": {"role": "fragment"}
            })
            parts_debug_info.append(part_debug)

        if not parts:
            return None

        # Drop empty parts (parts with no data rows) if configured
        drop_empty_parts = detect.get("drop_empty_parts", True)
        if drop_empty_parts:
            filtered_parts = []
            filtered_debug = []
            for idx, part in enumerate(parts):
                row_count = self._count_data_rows(toks_by_page.get(part["page"], []), part["bbox"], defaults)
                parts_debug_info[idx]["data_row_count"] = row_count
                if row_count > 0:
                    filtered_parts.append(part)
                    filtered_debug.append(parts_debug_info[idx])
                else:
                    parts_debug_info[idx]["dropped"] = True

            if not filtered_parts:
                logger.info(f"All parts dropped for region '{region_config['id']}' (no data rows)")
                return None

            parts = filtered_parts
            parts_debug_info = filtered_debug

        # Count data rows for each part (for canonical selection and debug)
        for idx, part in enumerate(parts):
            if "data_row_count" not in parts_debug_info[idx]:
                row_count = self._count_data_rows(toks_by_page.get(part["page"], []), part["bbox"], defaults)
                parts_debug_info[idx]["data_row_count"] = row_count

        # Choose value part per policy
        value_idx = 0
        canonical_selection_reason = None

        if value_part_policy == "end" or value_part_policy == "last":
            value_idx = len(parts) - 1
            canonical_selection_reason = f"policy={value_part_policy}"
        elif value_part_policy == "start" or value_part_policy == "first":
            value_idx = 0
            canonical_selection_reason = f"policy={value_part_policy}"
        elif value_part_policy == "first_numeric":
            # Find first part with numeric rows
            value_idx = 0
            for i in range(len(parts)):
                if parts_debug_info[i].get("data_row_count", 0) > 0:
                    value_idx = i
                    canonical_selection_reason = f"policy=first_numeric, page={parts[i]['page']}, rows={parts_debug_info[i]['data_row_count']}"
                    break
            if canonical_selection_reason is None:
                canonical_selection_reason = f"policy=first_numeric (fallback to first, no numeric rows found)"
        elif value_part_policy == "last_numeric":
            # Find last part with numeric rows (scan backward)
            value_idx = len(parts) - 1
            for i in range(len(parts) - 1, -1, -1):
                if parts_debug_info[i].get("data_row_count", 0) > 0:
                    value_idx = i
                    canonical_selection_reason = f"policy=last_numeric, page={parts[i]['page']}, rows={parts_debug_info[i]['data_row_count']}"
                    break
            if canonical_selection_reason is None:
                canonical_selection_reason = f"policy=last_numeric (fallback to last, no numeric rows found)"
        else:
            # Default to last
            value_idx = len(parts) - 1
            canonical_selection_reason = f"policy={value_part_policy} (unknown, defaulted to last)"

        value_part = parts[value_idx]

        # Canonical bbox selection
        if canonical_bbox_mode == "union" and len(parts) > 1:
            # Union envelope of parts' bboxes
            boxes = [BBox.from_list(p["bbox"]) for p in parts]
            union_box = BBox.union_many(boxes)
            canon_bbox = union_box.to_list(self.config.get("coords", {}).get("precision", 6))
        else:
            canon_bbox = value_part["bbox"]

        # Canonical segment: page/bbox per selection
        canonical = {
            "id": region_config["id"],
            "type": "region",
            "page": int(value_part["page"]),
            "bbox": canon_bbox,
            "label": region_config.get("label", region_config["id"]),
            "spanning": True,
            "parts": parts,
            "metadata": {
                "role": "canonical",
                "anchor_scope": "document",
                "anchors": {
                    "start": start_match.get("matched_text"),
                    "end": (end_match or {}).get("matched_text") if end_match else None
                },
                "value_part_policy": value_part_policy,
                "canonical_selection_reason": canonical_selection_reason,
                "debug": {
                    "start_page": start_page,
                    "end_page": end_page,
                    "total_parts": len(parts),
                    "canonical_part_index": value_idx,
                    "parts_debug": parts_debug_info,
                    "config_used": {
                        "skip_page_headers": skip_page_headers,
                        "use_per_page_header_floors": use_per_page_header_floors,
                        "max_page_gap": max_page_gap,
                        "drop_empty_parts": drop_empty_parts
                    }
                }
            }
        }

        canonical_page = canonical.get("page")
        if canonical_page:
            canonical["bbox"] = self._trim_bbox_with_markers(
                canonical["bbox"],
                marker_boxes_by_page.get(int(canonical_page), []),
                precision,
            )

        return canonical

    # ---------------------------------------------------------------------
    # Stitching Pass
    # ---------------------------------------------------------------------
    def _stitch_fragments(self, segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Stitch region fragments across adjacent pages into a single logical region.

        Rules:
        - Group by metadata.split_group if present; otherwise, by id prefix when a
          region's config has stitch.group_by == "id_prefix".
        - Only stitch when pages are adjacent or within a small gap and their
          vertical placement is consistent (earlier page near bottom; next page near top).
        - Keep original fragments but mark them with metadata.role = "fragment".
        - Emit a canonical stitched region with metadata.role = "canonical",
          spanning=true, parts=[...], and id equal to the group id. If a fragment
          already uses the canonical id, rename it to avoid collision.

        Config (per-region, non-breaking):
          "stitch": {
            "group_by": "split_group|id_prefix",  # default: split_group
            "emit": "group|fragments_only",        # default: group
            "value_policy": "prefer_last_numeric", # optional hint
            "max_page_gap": 1,                      # default 1 (adjacent)
            "bottom_min_y0": 0.60,                  # default 0.60
            "top_max_y1": 0.40                      # default 0.40
          }

        If stitch block is absent but fragment metadata contains split_group,
        we use split_group with default thresholds.
        """
        if not segments:
            return segments

        # Build quick index for region config and defaults
        def _cfg_for_id(rid: str) -> Dict[str, Any]:
            return self._region_index.get(rid) or {}

        def _stitch_cfg_for_id(rid: str) -> Dict[str, Any]:
            return dict(_cfg_for_id(rid).get("stitch", {}) or {})

        def _group_by_for_id(rid: str) -> str:
            scfg = _stitch_cfg_for_id(rid)
            return str(scfg.get("group_by", "split_group")).lower()

        # Thresholds with sensible defaults (may be overridden per region)
        def _thresholds_for_id(rid: str) -> Tuple[int, float, float]:
            scfg = _stitch_cfg_for_id(rid)
            max_gap = int(scfg.get("max_page_gap", 1))
            bottom_min = float(scfg.get("bottom_min_y0", 0.60))
            top_max = float(scfg.get("top_max_y1", 0.40))
            return max_gap, bottom_min, top_max

        def _emit_mode_for_id(rid: str) -> str:
            scfg = _stitch_cfg_for_id(rid)
            return str(scfg.get("emit", "group")).lower()

        def _value_policy_for_id(rid: str) -> Optional[str]:
            scfg = _stitch_cfg_for_id(rid)
            vp = scfg.get("value_policy")
            return str(vp) if isinstance(vp, str) else None

        def _id_base(id_: str) -> str:
            # Use last underscore as separator and recognize common suffixes
            # e.g., total_top -> total, total_bottom -> total, total_p1 -> total
            m = re.match(r"^(.*)_(top|bottom|left|right|p\d+|part\d+)$", id_)
            return m.group(1) if m else id_

        def _bbox_from_list(b: List[float]) -> BBox:
            return BBox(float(b[0]), float(b[1]), float(b[2]), float(b[3]))

        # Pre-pass: tag every segment with its split_group if present
        for s in segments:
            md = s.setdefault("metadata", {})
            if "split_group" in md and not isinstance(md["split_group"], str):
                # normalize to string
                md["split_group"] = str(md["split_group"])

        # Build candidate groups
        group_map: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        group_meta: Dict[str, Dict[str, Any]] = {}  # accrued meta per group

        for s in segments:
            rid = s.get("id")
            md = s.get("metadata", {})
            group_id: Optional[str] = None
            grouping = None

            # 1) Prefer explicit split_group on the fragment itself
            sg = md.get("split_group")
            if isinstance(sg, str) and sg.strip():
                group_id = sg.strip()
                grouping = "split_group"
            else:
                # 2) Try region-config stitch.group_by
                gb = _group_by_for_id(rid)
                if gb == "id_prefix":
                    base = _id_base(rid)
                    if base and base != rid:  # only if suffix detected
                        group_id = base
                        grouping = "id_prefix"

            if not group_id:
                continue

            group_map[group_id].append(s)
            # Track the most specific emit/policy seen for the group (first wins)
            if group_id not in group_meta:
                group_meta[group_id] = {
                    "emit": _emit_mode_for_id(rid),
                    "value_policy": _value_policy_for_id(rid),
                    "grouping": grouping
                }

        if not group_map:
            return segments

        # Helper: verify if list of parts is stitchable w.r.t. adjacency and vertical order
        def is_stitchable(parts: List[Dict[str, Any]], rid_hint: str) -> bool:
            if len(parts) < 2:
                return False
            parts_sorted = sorted(parts, key=lambda s: (int(s.get("page", 0) or 0), s["bbox"][1]))
            max_gap, bottom_min, top_max = _thresholds_for_id(rid_hint)

            # Basic page adjacency monotonicity
            pages = [int(p.get("page", 0) or 0) for p in parts_sorted]
            if any(p <= 0 for p in pages):
                return False
            if any(pages[i+1] < pages[i] for i in range(len(pages)-1)):
                return False
            if any((pages[i+1] - pages[i]) > max_gap for i in range(len(pages)-1)):
                return False

            # Vertical placement: first part near bottom, last part near top.
            first_box = _bbox_from_list(parts_sorted[0]["bbox"])
            last_box  = _bbox_from_list(parts_sorted[-1]["bbox"])
            if first_box.y0 < bottom_min:
                return False
            if last_box.y1 > top_max:
                return False

            # Same-page pairs are only permissible with explicit split_group
            for i in range(len(parts_sorted) - 1):
                a, b = parts_sorted[i], parts_sorted[i + 1]
                pa, pb = int(a.get("page", 0) or 0), int(b.get("page", 0) or 0)
                if pa == pb:
                    grouping = group_meta.get(rid_hint, {}).get("grouping")
                    if grouping != "split_group":
                        return False
            return True

        # Prepare augmented list of segments we will mutate and append to
        out: List[Dict[str, Any]] = list(segments)

        # For stable renaming when needed
        frag_suffix_counters: Dict[str, int] = defaultdict(int)

        for group_id, parts in group_map.items():
            # Determine a representative region id for config lookups
            rid_hint = parts[0].get("id") if parts else group_id
            meta = group_meta.get(group_id, {})
            emit_mode = meta.get("emit", "group")

            # Only consider stitching if enough parts and stitchable order
            if not is_stitchable(parts, rid_hint):
                continue

            # Sort by page then by top y
            parts_sorted = sorted(parts, key=lambda s: (int(s.get("page", 0) or 0), float(s["bbox"][1])))

            # Mark fragments and rename if any fragment already has the canonical id
            for p in parts_sorted:
                md = p.setdefault("metadata", {})
                md["role"] = "fragment"
                md.setdefault("split_group", group_id)
                if p.get("id") == group_id:
                    frag_suffix_counters[group_id] += 1
                    p["id"] = f"{group_id}__frag{frag_suffix_counters[group_id]}"

            # Compute union bbox across all parts (note: normalized units; page-agnostic)
            union_box = BBox.union_many([_bbox_from_list(p["bbox"]) for p in parts_sorted])

            # Prepare canonical region (after any renaming above)
            first_page = int(parts_sorted[0].get("page", 0) or 0)
            last_page = int(parts_sorted[-1].get("page", 0) or 0)
            stitched_from_ids = [p.get("id") for p in parts_sorted]
            # Prefer last part's page so downstream consumers capture the final values
            canonical: Dict[str, Any] = {
                "id": group_id,
                "type": "region",
                "page": last_page or first_page,
                "bbox": union_box.to_list(self.config.get("coords", {}).get("precision", 6)),
                "label": group_id,
                "spanning": True,
                "parts": [
                    {
                        "id": p.get("id"),
                        "page": int(p.get("page", 0) or 0),
                        "bbox": p.get("bbox"),
                        "metadata": p.get("metadata", {})
                    }
                    for p in parts_sorted
                ],
                "metadata": {
                    "role": "canonical",
                    "stitched_from": stitched_from_ids,
                    "split_group": group_id
                }
            }
            vp = _value_policy_for_id(rid_hint)
            if vp:
                canonical["metadata"]["value_policy"] = vp

            # Emit canonical according to policy, but avoid duplicate if a canonical with same id already exists
            if emit_mode != "fragments_only":
                existing = any(s for s in out if s.get("id") == group_id)
                if not existing:
                    out.append(canonical)
                    logger.info(f"Stitched {len(parts_sorted)} fragment(s) into canonical '{group_id}'")
                else:
                    logger.info(f"Skip stitching canonical for '{group_id}' (already present)")

        return out
    
    def _generate_overlay(self, segments_data: Dict[str, Any], pdf_path: Path) -> bool:
        """Generate PDF overlay with visual segments."""
        try:
            doc = fitz.open(str(pdf_path))
            
            # Group segments by page
            by_page: Dict[int, List[Dict[str, Any]]] = {}
            raw_segments = segments_data["segments"]
            for segment in raw_segments:
                page = int(segment.get("page", 0) or 0)
                if page > 0:
                    by_page.setdefault(page, []).append(segment)
            # Also draw cross-page parts if present
            for segment in raw_segments:
                if segment.get("spanning") and segment.get("parts"):
                    for idx, part in enumerate(segment["parts"], start=1):
                        ppage = int(part.get("page", 0) or 0)
                        if ppage <= 0:
                            continue
                        ghost = {
                            "id": f"{segment.get('id')}#part{idx}",
                            "type": "region",
                            "page": ppage,
                            "bbox": part.get("bbox"),
                            "label": f"{segment.get('id')} [p{idx}]",
                            "metadata": {"role": "fragment", "ghost": True}
                        }
                        by_page.setdefault(ppage, []).append(ghost)
            
            # Draw on each page
            for page_num, segments in by_page.items():
                if page_num - 1 >= len(doc):
                    continue
                
                page = doc[page_num - 1]
                for segment in segments:
                    self._draw_segment(page, segment)
            
            # Save overlay
            overlay_path = pdf_path.parent / f"{pdf_path.stem}-overlay.pdf"
            doc.save(str(overlay_path))
            doc.close()
            
            logger.info(f"Overlay saved to: {overlay_path}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to generate overlay: {e}")
            return False
    
    def _draw_segment(self, page: 'fitz.Page', segment: Dict[str, Any]) -> None:
        """Draw a segment on a PDF page."""
        # Get page dimensions
        rect = page.rect
        w, h = rect.width, rect.height
        
        # Convert normalized coords to PDF coords
        bbox = segment["bbox"]
        pdf_rect = fitz.Rect(
            bbox[0] * w, bbox[1] * h,
            bbox[2] * w, bbox[3] * h
        )
        
        # Get color based on ID
        colors = {
            "header": (0, 0, 1),
            "footer": (1, 0, 0),
            "invoice_number": (0, 1, 0),
            "amount": (1, 0, 1),
        }
        # Alternate color for ghost parts
        if segment.get("metadata", {}).get("ghost"):
            color = (0.2, 0.7, 0.2)
        else:
            color = colors.get(segment["id"], (0.5, 0.5, 0.5))
        
        # Draw rectangle
        page.draw_rect(pdf_rect, color=color, width=2)
        
        # Add label
        label = segment.get("label", segment["id"])
        page.insert_text(
            fitz.Point(pdf_rect.x0, pdf_rect.y0 - 2),
            label,
            fontsize=10,
            color=color
        )


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(description="Agnostic Region-Based Segmenter")
    parser.add_argument("--in", dest="inp", required=True, help="Input normalized JSON")
    parser.add_argument("--out", required=True, help="Output segmented JSON")
    parser.add_argument(
        "--tokenizer",
        required=True,
        choices=["plumber", "pymupdf"],
        help="Tokenizer engine to consume from Stage 2 output",
    )
    parser.add_argument("--config", help="Configuration file")
    parser.add_argument("--overlay", help="Source PDF for overlay generation")
    
    args = parser.parse_args()
    
    segmenter = AgnosticSegmenter(
        Path(args.config) if args.config else None
    )
    
    segmenter.segment(
        Path(args.inp),
        Path(args.out),
        args.tokenizer,
        Path(args.overlay) if args.overlay else None
    )


if __name__ == "__main__":
    main()
