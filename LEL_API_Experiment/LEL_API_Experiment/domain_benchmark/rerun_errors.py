from __future__ import annotations

import argparse
import asyncio
import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

from .config import BenchmarkConfig, load_config
from .runner import run_selected_benchmark


def load_result_rows(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path} line {line_number} is not valid JSON: {exc}") from exc
    return rows


def select_error_sample_ids(
    rows: list[dict[str, Any]],
    error_types: set[str] | None = None,
    sample_ids: set[str] | None = None,
    limit: int | None = None,
) -> list[str]:
    selected: list[str] = []
    seen: set[str] = set()
    for row in rows:
        sample_id = str(row.get("sample_id") or "")
        error_type = str(row.get("error_type") or "")
        if not sample_id or not error_type:
            continue
        if error_types and error_type not in error_types:
            continue
        if sample_ids and sample_id not in sample_ids:
            continue
        if sample_id in seen:
            continue
        seen.add(sample_id)
        selected.append(sample_id)
        if limit is not None and len(selected) >= limit:
            break
    return selected


def rewrite_without_samples(path: Path, sample_ids: set[str]) -> dict[str, Any]:
    rows = load_result_rows(path)
    kept = [row for row in rows if str(row.get("sample_id")) not in sample_ids]
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in kept),
        encoding="utf-8",
    )
    return {"before_rows": len(rows), "after_rows": len(kept), "removed_rows": len(rows) - len(kept)}


async def rerun_errors(
    config: BenchmarkConfig,
    error_types: set[str] | None = None,
    sample_ids: set[str] | None = None,
    limit: int | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    result_path = config.resolved_output_path
    error_path = result_path.parent / "errors.jsonl"
    if not result_path.exists() and not error_path.exists():
        return {
            "result_path": str(result_path),
            "error_path": str(error_path),
            "selected_error_samples": [],
            "message": "results and errors files do not exist",
            "dry_run": dry_run,
        }

    rows: list[dict[str, Any]] = []
    if error_path.exists():
        rows.extend(load_result_rows(error_path))
    if result_path.exists():
        rows.extend(load_result_rows(result_path))
    selected = select_error_sample_ids(rows, error_types=error_types, sample_ids=sample_ids, limit=limit)
    summary: dict[str, Any] = {
        "model_name": config.model_name,
        "result_path": str(result_path),
        "error_path": str(error_path),
        "selected_error_samples": selected,
        "selected_count": len(selected),
        "error_types": sorted(error_types) if error_types else None,
        "dry_run": dry_run,
    }
    if dry_run or not selected:
        return summary

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    selected_set = set(selected)
    backups: dict[str, str] = {}
    rewrites: dict[str, Any] = {}
    if error_path.exists():
        backup_path = error_path.with_name(f"{error_path.stem}.before-rerun-errors.{timestamp}{error_path.suffix}")
        shutil.copy2(error_path, backup_path)
        backups["errors"] = str(backup_path)
        rewrites["errors"] = rewrite_without_samples(error_path, selected_set)
    if result_path.exists():
        backup_path = result_path.with_name(f"{result_path.stem}.before-rerun-errors.{timestamp}{result_path.suffix}")
        shutil.copy2(result_path, backup_path)
        backups["results"] = str(backup_path)
        rewrites["results"] = rewrite_without_samples(result_path, selected_set)
    error_raw_dir = result_path.parent / "error_raw"
    retry_backup_dir = result_path.parent / f"error_raw.before-rerun-errors.{timestamp}"
    moved_error_raw = 0
    if error_raw_dir.exists():
        for sample_id in selected:
            raw_path = error_raw_dir / f"{sample_id}.json"
            if raw_path.exists():
                retry_backup_dir.mkdir(parents=True, exist_ok=True)
                shutil.move(str(raw_path), str(retry_backup_dir / raw_path.name))
                moved_error_raw += 1
    summary["backup_paths"] = backups
    summary["rewrite"] = rewrites
    summary["moved_error_raw_files"] = moved_error_raw
    run_summary = await run_selected_benchmark(config, sample_ids=selected_set, retry_errors=True)
    summary["run_summary"] = run_summary
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Rerun failed/error samples for the configured model.")
    parser.add_argument("--config", default="config.yaml", help="Config YAML path.")
    parser.add_argument("--error-type", action="append", default=None, help="Only rerun this error type. Can repeat.")
    parser.add_argument("--sample-id", action="append", default=None, help="Only rerun this sample_id. Can repeat.")
    parser.add_argument("--limit", type=int, default=None, help="Rerun only the first N matching error samples.")
    parser.add_argument("--dry-run", action="store_true", help="Preview selected error samples without modifying files.")
    args = parser.parse_args(argv)
    config = load_config(args.config)
    summary = asyncio.run(
        rerun_errors(
            config,
            error_types=set(args.error_type) if args.error_type else None,
            sample_ids=set(args.sample_id) if args.sample_id else None,
            limit=args.limit,
            dry_run=args.dry_run,
        )
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
