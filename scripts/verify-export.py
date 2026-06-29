#!/usr/bin/env python3
"""
Verify Budget XLSX export against original Budget.xlsx.
Downloads fresh export, runs 7 verification scripts, diagnoses any ❌, suggests fixes.
"""
import subprocess
import sys
import os
import re
from pathlib import Path

# Paths
TMP_CLAUDE = r"C:\Users\doter\AppData\Local\Temp\claude"
TMP_ROOT = r"C:\Users\doter\AppData\Local\Temp"
URL = "http://localhost:3000/api/export"
SCRIPTS = [
    "iter5_deep",
    "iter8_final",
    "iter9_comprehensive",
    "iter10_broader",
    "iter11_deep2",
    "iter12_cf_and_data",
    "iter13_xml_deep",
]

# Error pattern database: (❌ pattern) → (where in route.ts, what to check)
ERROR_PATTERNS = {
    "selection": ("Line 268-270", "sheet1.xml attribute order in Pass 2"),
    "drawing": ("Line 171-253", "drawing restoration or worksheet XML refs"),
    "comment": ("Line 68-119", "buildComments() function or XML generation"),
    "style": ("Line 256-225", "styles.xml Pass 1 fixes"),
    "margin": ("Line 235", "pageMargins footer/header float fix"),
    "fill": ("Line 143-159", "noFill on D-G cells or alignment style"),
    "align": ("Line 240-244", "alignment style replace in Pass 2 sheet3"),
    "numfmt": ("Line 207-209", "number format escape in styles.xml"),
    "formula": ("Line 250-253", "date DV formula .0 restoration"),
}

def run(cmd, desc=""):
    """Run command, return (exitcode, stdout)."""
    try:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30, encoding='utf-8', errors='replace')
        return result.returncode, result.stdout + result.stderr
    except subprocess.TimeoutExpired:
        return -1, f"Timeout: {desc}"
    except Exception as e:
        return -1, f"Error: {e}"

def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    print("\n" + "="*60)
    print("VERIFY EXPORT")
    print("="*60)

    # Step 1: Download export
    print("\n[1/3] Downloading export from http://localhost:3000/api/export...")
    code, out = run(
        f'curl -s "{URL}" -o "{TMP_CLAUDE}\\test_loop.xlsx" -w "%{{http_code}}"',
        "download export"
    )
    if code != 0 or not out.strip().endswith("200"):
        print("❌ FAIL: Could not download export (HTTP error or server down)")
        print(f"   Response: {out}")
        return 1

    # Copy to both temp locations
    code, _ = run(
        f'copy "{TMP_CLAUDE}\\test_loop.xlsx" "{TMP_ROOT}\\test_loop.xlsx"',
        "copy to temp"
    )
    if code != 0:
        print("⚠️  Warning: Could not copy to secondary temp path")
    print("✅ Export downloaded")

    # Step 2: Run all 7 scripts
    print("\n[2/3] Running verification scripts...")
    results = {}
    total_fail = 0

    for script in SCRIPTS:
        script_path = os.path.join(TMP_CLAUDE, f"{script}.py")
        code, out = run(f'python "{script_path}"', script)

        # Extract summary line
        summary_match = re.search(r"ПІДСУМОК:.*", out)
        summary = summary_match.group(0) if summary_match else "(no summary)"

        # Count actual ❌ error lines (lines starting with "  ❌") not from summary
        # Summary line says "0 ❌ помилок" but actual error lines start with "  ❌"
        error_lines = [line for line in out.split('\n') if line.strip().startswith('❌') and 'ПІДСУМОК' not in line]
        errors = len(error_lines)
        total_fail += errors

        results[script] = {
            "summary": summary,
            "errors": errors,
            "output": out,
        }

        color_icon = "❌" if errors > 0 else "✅"
        print(f"  {color_icon} {script}: {summary}")

    # Step 3: Diagnose errors
    print("\n[3/3] Analysis...")
    if total_fail == 0:
        print("✅ SUCCESS: All 7 scripts passed, 0 ❌ errors")
        print("\n" + "="*60)
        return 0

    print(f"\n❌ Found {total_fail} error(s). Diagnosis:")
    print("-" * 60)

    all_errors = []
    for script, data in results.items():
        if data["errors"] == 0:
            continue

        # Find actual ❌ lines (not ⚠️)
        for line in data["output"].split("\n"):
            if "❌" in line and "⚠️" not in line:
                all_errors.append((script, line.strip()))

    for script, error_line in all_errors:
        print(f"\n{script}:")
        print(f"  Error: {error_line[:100]}")

        # Try to match against known patterns
        matched = False
        for pattern, (location, description) in ERROR_PATTERNS.items():
            if pattern.lower() in error_line.lower():
                print(f"  → {location}: {description}")
                matched = True
                break

        if not matched:
            print(f"  → Check src/app/api/export/route.ts for XML/style issues")

    print("\n" + "="*60)
    print("NEXT: Fix the errors in route.ts, then run this script again.")
    print("="*60 + "\n")
    return 1

if __name__ == "__main__":
    sys.exit(main())
