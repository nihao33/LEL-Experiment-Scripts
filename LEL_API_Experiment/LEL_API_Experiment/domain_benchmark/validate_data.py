from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


EXPECTED_FIELDS = {"sample_id", "registered_domain", "target_url", "prompt"}
URL_WITH_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://")


def validate_benchmark(path: str | Path, expected_rows: int | None = None) -> dict[str, Any]:
    source = Path(path)
    errors: list[str] = []
    warnings: list[str] = []
    seen_ids: set[str] = set()
    row_count = 0

    with source.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                warnings.append(f"line {line_number}: blank line ignored")
                continue
            row_count += 1
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                errors.append(f"line {line_number}: invalid JSON: {exc}")
                continue

            fields = set(record.keys())
            if fields != EXPECTED_FIELDS:
                errors.append(
                    f"line {line_number}: fields must be {sorted(EXPECTED_FIELDS)}, got {sorted(fields)}"
                )
                continue

            sample_id = str(record["sample_id"])
            if not re.fullmatch(r"\d{6}", sample_id):
                errors.append(f"line {line_number}: invalid sample_id {sample_id!r}")
            if sample_id in seen_ids:
                errors.append(f"line {line_number}: duplicate sample_id {sample_id}")
            seen_ids.add(sample_id)

            for field in ("registered_domain", "target_url", "prompt"):
                if not str(record[field]).strip():
                    errors.append(f"line {line_number}: empty {field}")

            target_url = str(record["target_url"]).strip()
            if target_url and not URL_WITH_SCHEME.match(target_url):
                warnings.append(f"line {line_number}: target_url has no URL scheme: {target_url!r}")

    if expected_rows is not None and row_count != expected_rows:
        errors.append(f"row count mismatch: expected {expected_rows}, got {row_count}")

    return {
        "path": str(source),
        "rows": row_count,
        "expected_rows": expected_rows,
        "errors": errors,
        "warnings": warnings,
        "ok": not errors,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate benchmark JSONL structure.")
    parser.add_argument("--input", default="benchmark.jsonl", help="Benchmark JSONL path.")
    parser.add_argument("--expected-rows", type=int, default=None, help="Expected sample count.")
    args = parser.parse_args(argv)

    summary = validate_benchmark(args.input, args.expected_rows)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

