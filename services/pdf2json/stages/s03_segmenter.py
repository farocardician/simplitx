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
from typing import Any, Dict, List, Optional, Tuple, Union, Callable, Sequence
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
        """Check if a row looks like a table header."""
        if len(row) < 2:  # Need multiple columns
            return False
        
        row_text = " ".join(t.get("norm", t.get("text", "")) for t in row).upper()
        
        # Score based on common header keywords
        score = 0
        header_keywords = [
            ("NO", 1), ("ITEM", 1), ("QTY", 1), ("QUANTITY", 1),
            ("DESC", 1), ("DESCRIPTION", 1), ("GOODS", 1),
            ("PRICE", 1), ("AMOUNT", 1), ("TOTAL", 1),
            ("UNIT", 1), ("RATE", 1), ("VALUE", 1)
        ]
        
        for keyword, weight in header_keywords:
            if keyword in row_text:
                score += weight
        
        return score >= 3
    
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

        # Defaults shared across modes
        dx_max = float(capture_window.get("dx_max", 0.35))
        dy_max = float(capture_window.get("dy_max", 0.15))
        dy_tol = float(capture_window.get("dy_tol", 0.008))
        gap_x  = max(0.0, float(capture_window.get("gap_x", 0.0)))

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
            "by_table": DetectionModes.by_table,
            "y_cutoff": DetectionModes.y_cutoff,
            "fixed_box": DetectionModes.fixed_box,
        }
    
    def _group_rows(self, tokens: List[Dict[str, Any]], page: int) -> List[List[Dict[str, Any]]]:
        """Group tokens into rows by Y coordinate."""
        page_tokens = [t for t in tokens if t["page"] == page]
        if not page_tokens:
            return []
        
        page_tokens.sort(key=lambda t: (t["bbox"]["y0"], t["bbox"]["x0"]))
        
        # Group by Y with tolerance
        y_tol = self.config.get("tolerances", {}).get("y_line_tol", 0.006)
        rows = []
        current_row = []
        last_y = None
        
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
    
    def _process_region(self, region_config: Dict[str, Any], pages: List[int],
                       tokens: List[Dict[str, Any]], total_pages: int) -> List[Dict[str, Any]]:
        """Process a region across specified pages."""
        region_id = region_config["id"]
        keep_policy = region_config.get("keep", "all")

        logger.info(f"Begin region '{region_id}' on pages {pages[:5]}{'...' if len(pages) > 5 else ''}")

        # Cross-page anchors path (document scope) — optional and backward compatible
        detect_cfg = region_config.get("detect", {}) or {}
        is_anchors = (detect_cfg.get("by") == "anchors")
        if is_anchors:
            anchor_scope = str(detect_cfg.get("anchor_scope", "auto")).lower()
            max_gap = int(detect_cfg.get("max_page_gap", 1))
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
                    total_pages=total_pages
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
                region_config, page, tokens, total_pages
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
    
    def _process_region_on_page(self, region_config: Dict[str, Any], page: int,
                                tokens: List[Dict[str, Any]], total_pages: int) -> Optional[Dict[str, Any]]:
        """Process a single region on a specific page."""
        region_id = region_config["id"]
        
        # Group tokens into rows
        rows = self._group_rows(tokens, page)
        
        # Build context with defaults
        ctx = Context(
            page=page,
            total_pages=total_pages,
            tokens=[t for t in tokens if t["page"] == page],
            rows=rows,
            table_provider=self.table_provider,
            config=self.config,
            logger=logger,
            defaults=self.config.get("defaults", {})
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
    
    def segment_page_with_dependencies(self, regions: List[Dict[str, Any]], 
                                      page: int, tokens: List[Dict[str, Any]], 
                                      total_pages: int) -> List[Dict[str, Any]]:
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
            segment = self._process_region_on_page(region_config, page, tokens, total_pages)
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
    
    def segment(self, in_path: Path, out_path: Path, overlay_pdf: Optional[Path] = None) -> Dict[str, Any]:
        """Main segmentation entry point."""
        # Load input
        data = json.loads(in_path.read_text(encoding="utf-8"))
        tokens = data.get("tokens", [])
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
                segments = self._process_region(region_config, pages, tokens, page_count)
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
                        all_page_regions, page, tokens, page_count
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
            "output": str(out_path)
        }, indent=2))
        
        return output

    # ---------------------------------------------------------------------
    # Cross-page Anchors (document scope)
    # ---------------------------------------------------------------------
    def _detect_anchors_cross_page(self,
                                   region_config: Dict[str, Any],
                                   pages: List[int],
                                   tokens: List[Dict[str, Any]],
                                   total_pages: int) -> Optional[Dict[str, Any]]:
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
        max_page_gap = int(detect.get("max_page_gap", 1))
        value_part_policy = str(detect.get("value_part_policy", "end")).lower()
        canonical_bbox_mode = str(detect.get("canonical_bbox", "value")).lower()  # "value"|"union"

        # Margins and horizontal/row policy
        defaults = self.config.get("defaults", {}) or {}
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

        # Build row maps per page, using the segmenter's row grouper
        rows_by_page: Dict[int, List[List[Dict[str, Any]]]] = {}
        row_bounds_by_page: Dict[int, List[Tuple[float, float]]] = {}
        for p in pages:
            rows = self._group_rows(tokens, p)
            rows_by_page[p] = rows
            bounds = []
            for r in rows:
                if not r:
                    continue
                y0 = min(float(t["bbox"]["y0"]) for t in r)
                y1 = max(float(t["bbox"]["y1"]) for t in r)
                bounds.append((y0, y1))
            row_bounds_by_page[p] = bounds

        # Find start anchor on candidate pages in order
        start_page = None
        start_match = None
        for p in pages:
            page_toks = toks_by_page.get(p, [])
            if not page_toks:
                continue
            sm = AnchorMatcher.match(page_toks, start_spec)
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
            em = AnchorMatcher.match(toks_by_page.get(start_page, []), end_spec, start_match)
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
                    em2 = AnchorMatcher.match(toks_by_page.get(p, []), end_spec)
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

        for i, p in enumerate(walk):
            if p == start_page and p == end_page:
                # Single-page case in document-scope path: use exact start..end bounds
                # Prefer row-aware bounds if configured
                if (start_rows_above or start_rows_below or end_rows_above or end_rows_below) and row_bounds_by_page.get(p):
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
                bbox = _clamp_bbox(x0_fixed, max(0.0, sy0), x1_fixed, min(1.0, ey1))
            elif p == start_page:
                if (start_rows_above or start_rows_below) and row_bounds_by_page.get(p):
                    ai = _row_index_for_anchor(p, start_match["bbox"]) if start_match else -1
                    bounds = row_bounds_by_page.get(p) or []
                    if bounds and ai >= 0:
                        lo = max(0, ai - max(0, start_rows_above))
                        hi = min(len(bounds) - 1, ai + max(0, start_rows_below))
                        sy0 = bounds[lo][0] - row_safety
                        # Extend to bottom unless end is on same page
                        bbox = _clamp_bbox(x0_fixed, max(0.0, sy0), x1_fixed, 1.0 - mb)
                    else:
                        sy0 = float(start_match["bbox"][1]) - mt
                        bbox = _clamp_bbox(x0_fixed, max(0.0, sy0), x1_fixed, 1.0 - mb)
                else:
                    sy0 = float(start_match["bbox"][1]) - mt
                    bbox = _clamp_bbox(x0_fixed, max(0.0, sy0), x1_fixed, 1.0 - mb)
            elif p == end_page:
                if (end_rows_above or end_rows_below) and row_bounds_by_page.get(p):
                    ei = _row_index_for_anchor(p, (end_match or start_match)["bbox"]) if (end_match or start_match) else -1
                    bounds = row_bounds_by_page.get(p) or []
                    if bounds and ei >= 0:
                        lo = max(0, ei - max(0, end_rows_above))
                        hi = min(len(bounds) - 1, ei + max(0, end_rows_below))
                        y0 = bounds[lo][0] - row_safety
                        y1 = bounds[hi][1] + row_safety
                        bbox = _clamp_bbox(x0_fixed, max(0.0, y0), x1_fixed, min(1.0, y1))
                    else:
                        if end_match is not None:
                            ey1 = float(end_match["bbox"][3]) + mb
                        else:
                            ey1 = float(cutoff_y)
                        bbox = _clamp_bbox(x0_fixed, mt, x1_fixed, min(1.0, ey1))
                else:
                    if end_match is not None:
                        ey1 = float(end_match["bbox"][3]) + mb
                    else:
                        ey1 = float(cutoff_y)
                    bbox = _clamp_bbox(x0_fixed, mt, x1_fixed, min(1.0, ey1))
            else:
                bbox = _clamp_bbox(x0_fixed, mt, x1_fixed, 1.0 - mb)

            parts.append({
                "id": f"{region_config['id']}__p{i+1}",
                "page": int(p),
                "bbox": bbox,
                "metadata": {"role": "fragment"}
            })

        if not parts:
            return None

        # Choose value part per policy
        value_idx = 0
        if value_part_policy == "end":
            value_idx = len(parts) - 1
        elif value_part_policy == "start":
            value_idx = 0
        elif value_part_policy == "last_numeric":
            num_rx = re.compile(r"\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?")
            value_idx = len(parts) - 1
            for i in range(len(parts) - 1, -1, -1):
                part = parts[i]
                page = part["page"]
                bx = part["bbox"]
                # collect tokens intersecting bbox on that page
                hit = False
                for t in toks_by_page.get(page, []):
                    tb = t.get("bbox", {})
                    if tb.get("x1", 0) <= bx[0] or tb.get("x0", 0) >= bx[2]:
                        continue
                    if tb.get("y0", 1) >= bx[3] or tb.get("y1", 0) <= bx[1]:
                        continue
                    text = t.get("norm") or t.get("text") or ""
                    if num_rx.search(text):
                        hit = True
                        break
                if hit:
                    value_idx = i
                    break

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
                "value_part_policy": value_part_policy
            }
        }

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
            "invoice_no": (0, 1, 0),
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
    parser.add_argument("--config", help="Configuration file")
    parser.add_argument("--overlay", help="Source PDF for overlay generation")
    
    args = parser.parse_args()
    
    segmenter = AgnosticSegmenter(
        Path(args.config) if args.config else None
    )
    
    segmenter.segment(
        Path(args.inp),
        Path(args.out),
        Path(args.overlay) if args.overlay else None
    )


if __name__ == "__main__":
    main()
