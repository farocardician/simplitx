#!/usr/bin/env python3
"""Test description improvements across all Simon variants."""
import json
import subprocess
import sys
from pathlib import Path

results = []
discrepancies = []

for n in range(1, 11):
    variant_dir = Path(f"services/pdf2json/training/simon/{n}")
    s02_path = variant_dir / "s02.json"
    gold_path = variant_dir / "s06-GOLD.json"
    s06_path = variant_dir / "s06.json"

    if not s02_path.exists():
        print(f"Variant {n}: s02.json not found, skipping")
        continue

    # Run extractor
    cmd = ["python3", "s06_line_items_from_cells_simon.py", "--input", str(s02_path), "--log-level", "ERROR"]
    subprocess.run(cmd, capture_output=True)

    if not s06_path.exists():
        print(f"Variant {n}: extraction failed")
        continue

    # Compare with GOLD if available
    if gold_path.exists():
        gold = json.load(open(gold_path))
        current = json.load(open(s06_path))

        exact, better, worse = 0, 0, 0
        for i in range(min(len(gold['items']), len(current['items']))):
            g_desc = gold['items'][i].get('description', '')
            c_desc = current['items'][i].get('description', '')
            no = current['items'][i].get('no')

            if g_desc == c_desc:
                exact += 1
            elif c_desc.replace(' (', '(').replace(' [', '[') == g_desc:
                better += 1
            else:
                worse += 1
                # Track significant discrepancies (not just spacing)
                if abs(len(g_desc) - len(c_desc)) > 10 or not c_desc or not g_desc:
                    discrepancies.append((n, no, g_desc, c_desc))

        total = min(len(gold['items']), len(current['items']))
        results.append({
            'variant': n,
            'total': total,
            'exact': exact,
            'better': better,
            'worse': worse,
            'good_pct': round(100 * (exact + better) / total) if total > 0 else 0
        })

        pct = exact*100//total if total > 0 else 0
        good_pct_display = (exact+better)*100//total if total > 0 else 0
        print(f"Variant {n}: {exact}/{total} exact ({pct}%), "
              f"{better} better, {worse} other -> {good_pct_display}% good")
    else:
        print(f"Variant {n}: no GOLD file for comparison")

# Summary
if results:
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    avg_exact = sum(r['exact'] for r in results) / len(results)
    avg_better = sum(r['better'] for r in results) / len(results)
    avg_good = sum(r['good_pct'] for r in results) / len(results)

    print(f"Average exact matches:  {avg_exact:.1f} per variant")
    print(f"Average better spacing: {avg_better:.1f} per variant")
    print(f"Average total good:     {avg_good:.0f}%")

    if discrepancies:
        print(f"\n{len(discrepancies)} significant discrepancies found")
        print("First 10 significant issues:")
        for n, no, g, c in discrepancies[:10]:
            print(f"  Variant {n}, item #{no}:")
            print(f"    GOLD: {repr(g[:80])}")
            print(f"    CURR: {repr(c[:80])}")
