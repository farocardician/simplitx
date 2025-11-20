#!/usr/bin/env python3
"""Utility to move PDFs that do not contain any detectable text layer."""

from __future__ import annotations

import argparse
import shutil
from dataclasses import dataclass
from pathlib import Path

import fitz


DEFAULT_SOURCE = "/app/training/simon/bulk"
DEFAULT_DESTINATION = "/app/training/simon/bulk_no_text"


@dataclass
class PdfCheckResult:
    path: Path
    has_text: bool
    reason: str
    moved_to: Path | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Move PDFs without text layers to a separate directory "
            "(uses pdfminer to detect text)."
        )
    )
    parser.add_argument(
        "--source",
        default=DEFAULT_SOURCE,
        help=f"Directory containing PDFs to inspect (default: {DEFAULT_SOURCE})",
    )
    parser.add_argument(
        "--destination",
        default=DEFAULT_DESTINATION,
        help=(
            "Directory where PDFs without text layers should be moved "
            f"(default: {DEFAULT_DESTINATION})"
        ),
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Maximum number of PDFs to process (0 means no limit).",
    )
    parser.add_argument(
        "--min-characters",
        type=int,
        default=12,
        help="Minimum number of alphanumeric characters required to count as text.",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=3,
        help="Maximum number of pages per document to inspect (0 means all).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would be moved without actually modifying files.",
    )
    return parser.parse_args()


def detect_text(pdf_path: Path, min_characters: int, max_pages: int) -> tuple[bool, str]:
    try:
        doc = fitz.open(pdf_path)
    except Exception as exc:
        return False, f"open failed: {exc}"

    with doc:
        pages_to_scan = len(doc) if max_pages <= 0 else min(len(doc), max_pages)
        alnum_count = 0

        for page_index in range(pages_to_scan):
            page = doc[page_index]
            text = page.get_text("text") or ""
            alnum_count += sum(ch.isalnum() for ch in text)

        if alnum_count >= min_characters:
            return True, f"found {alnum_count} alphanumeric characters"
        return False, f"only {alnum_count} alphanumeric characters"


def unique_destination_path(target: Path) -> Path:
    if not target.exists():
        return target

    counter = 1
    stem, suffix = target.stem, target.suffix
    while True:
        candidate = target.with_name(f"{stem}_{counter}{suffix}")
        if not candidate.exists():
            return candidate
        counter += 1


def move_file(source: Path, destination_dir: Path, dry_run: bool) -> Path | None:
    if not source.exists():
        return None

    destination_dir.mkdir(parents=True, exist_ok=True)
    target_path = unique_destination_path(destination_dir / source.name)
    if dry_run:
        return target_path

    try:
        source.rename(target_path)
    except FileNotFoundError:
        return None
    except OSError:
        # Fall back to copy + remove if rename crosses devices.
        shutil.copy2(source, target_path)
        source.unlink()
    return target_path


def process_pdfs(args: argparse.Namespace) -> list[PdfCheckResult]:
    source_dir = Path(args.source).expanduser().resolve()
    destination_dir = Path(args.destination).expanduser().resolve()

    if not source_dir.exists():
        raise SystemExit(f"Source directory does not exist: {source_dir}")

    pdf_paths = sorted(source_dir.glob("*.pdf"))
    results: list[PdfCheckResult] = []

    for idx, pdf_path in enumerate(pdf_paths, start=1):
        if args.limit and idx > args.limit:
            break

        has_text, reason = detect_text(pdf_path, args.min_characters, args.max_pages)
        result = PdfCheckResult(pdf_path, has_text, reason)

        if not has_text:
            moved_to = move_file(pdf_path, destination_dir, args.dry_run)
            result.moved_to = moved_to

        results.append(result)

    return results


def summarize(results: list[PdfCheckResult]) -> None:
    total = len(results)
    with_text = sum(1 for r in results if r.has_text)
    moved = total - with_text

    print(f"Processed {total} PDF(s).")
    print(f"  With text layers: {with_text}")
    print(f"  Removed (no text detected): {moved}")
    for result in results:
        status = "HAS TEXT" if result.has_text else "NO TEXT"
        moved_note = ""
        if result.moved_to:
            moved_note = f" -> moved to {result.moved_to}"
        elif not result.has_text:
            moved_note = " -> could not move (missing source?)"
        print(f"[{status}] {result.path.name}: {result.reason}{moved_note}")


def main() -> None:
    args = parse_args()
    results = process_pdfs(args)
    if not results:
        print("No PDF files found to process.")
        return
    summarize(results)


if __name__ == "__main__":
    main()
