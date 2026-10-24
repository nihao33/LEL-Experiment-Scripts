from __future__ import annotations

import argparse
import csv
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .domain_matcher import contains_warning, domain_is_recovered, extract_domains


@dataclass(frozen=True)
class SummaryOptions:
    outputs_dir: Path = Path("outputs")
    model: str | None = None
    rewrite: bool = False
    model_files: bool = True
    summary_json: Path | None = None
    summary_csv: Path | None = None


def summarize_outputs(options: SummaryOptions) -> dict[str, Any]:
    model_dirs = _model_dirs(options.outputs_dir, options.model)
    summaries = []
    for model_dir in model_dirs:
        result_path = model_dir / "results.jsonl"
        if not result_path.exists():
            continue
        rows, skipped_bad_lines = _load_jsonl(result_path)
        row_changes = _recalculate_rows(rows)
        if options.rewrite and row_changes:
            _write_jsonl(result_path, rows)
        model_summary = _summarize_model(model_dir.name, result_path, rows, row_changes)
        model_summary["skipped_bad_json_lines"] = skipped_bad_lines
        if options.model_files:
            _write_model_files(model_dir, model_summary, rows)
        summaries.append(model_summary)

    report = {
        "outputs_dir": str(options.outputs_dir),
        "models": summaries,
        "model_count": len(summaries),
        "total_rows": sum(item["rows"] for item in summaries),
        "total_hits": sum(item["hits"] for item in summaries),
        "total_errors": sum(item["errors"] for item in summaries),
    }
    if options.summary_json:
        options.summary_json.parent.mkdir(parents=True, exist_ok=True)
        options.summary_json.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    if options.summary_csv:
        _write_summary_csv(options.summary_csv, summaries)
    return report


def _model_dirs(outputs_dir: Path, model: str | None) -> list[Path]:
    if model:
        return [outputs_dir / model]
    if not outputs_dir.exists():
        return []
    return sorted(path for path in outputs_dir.iterdir() if path.is_dir())


def _load_jsonl(path: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    lines = path.read_text(encoding="utf-8").splitlines()
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            if line_number == len(lines):
                skipped.append({"line_number": line_number, "error": str(exc), "preview": line[:160]})
                continue
            raise ValueError(f"{path} line {line_number} is not valid JSON: {exc}") from exc
    return rows, skipped


def _write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows),
        encoding="utf-8",
    )


def _recalculate_rows(rows: list[dict[str, Any]]) -> int:
    changes = 0
    for row in rows:
        response_text = row.get("raw_response") or ""
        recovered = extract_domains(response_text)
        success = domain_is_recovered(row.get("registered_domain") or "", response_text)
        warning = contains_warning(response_text)
        if row.get("recovered_domains") != recovered or row.get("success") != success or row.get("contains_warning") != warning:
            changes += 1
        row["recovered_domains"] = recovered
        row["success"] = success
        row["contains_warning"] = warning
    return changes


def _summarize_model(model: str, path: Path, rows: list[dict[str, Any]], row_changes: int) -> dict[str, Any]:
    sample_ids = [str(row.get("sample_id")) for row in rows]
    duplicate_ids = sorted(sample_id for sample_id in set(sample_ids) if sample_ids.count(sample_id) > 1)
    hits = [row for row in rows if row.get("success") is True]
    errors = [row for row in rows if row.get("error_type")]
    warnings = [row for row in rows if row.get("contains_warning")]
    return {
        "model": model,
        "results_path": str(path),
        "rows": len(rows),
        "unique_samples": len(set(sample_ids)),
        "duplicate_sample_ids": duplicate_ids,
        "hits": len(hits),
        "hit_rate": round(len(hits) / len(rows), 6) if rows else 0.0,
        "errors": len(errors),
        "warnings": len(warnings),
        "row_changes_after_recalculation": row_changes,
        "hit_samples": [
            {
                "sample_id": row.get("sample_id"),
                "registered_domain": row.get("registered_domain"),
                "recovered_domains": row.get("recovered_domains") or [],
            }
            for row in hits
        ],
        "error_samples": [
            {
                "sample_id": row.get("sample_id"),
                "registered_domain": row.get("registered_domain"),
                "error_type": row.get("error_type"),
                "error_message": row.get("error_message"),
            }
            for row in errors
        ],
        "warning_samples": [
            {
                "sample_id": row.get("sample_id"),
                "registered_domain": row.get("registered_domain"),
            }
            for row in warnings
        ],
    }


def _write_summary_csv(path: Path, summaries: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "model",
                "rows",
                "unique_samples",
                "hits",
                "hit_rate",
                "errors",
                "warnings",
                "hit_sample_ids",
                "error_sample_ids",
                "results_path",
            ],
        )
        writer.writeheader()
        for item in summaries:
            writer.writerow(
                {
                    "model": item["model"],
                    "rows": item["rows"],
                    "unique_samples": item["unique_samples"],
                    "hits": item["hits"],
                    "hit_rate": item["hit_rate"],
                    "errors": item["errors"],
                    "warnings": item["warnings"],
                    "hit_sample_ids": ",".join(str(row["sample_id"]) for row in item["hit_samples"]),
                    "error_sample_ids": ",".join(str(row["sample_id"]) for row in item["error_samples"]),
                    "results_path": item["results_path"],
                }
            )


def _write_model_files(model_dir: Path, summary: dict[str, Any], rows: list[dict[str, Any]]) -> None:
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    _write_single_model_summary_csv(model_dir / "summary.csv", summary)
    _write_sample_rows_csv(model_dir / "hits.csv", [row for row in rows if row.get("success") is True])
    _write_sample_rows_csv(model_dir / "errors.csv", [row for row in rows if row.get("error_type")])


def _write_single_model_summary_csv(path: Path, summary: dict[str, Any]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "model",
                "rows",
                "unique_samples",
                "hits",
                "hit_rate",
                "errors",
                "warnings",
                "hit_sample_ids",
                "error_sample_ids",
                "results_path",
            ],
        )
        writer.writeheader()
        writer.writerow(
            {
                "model": summary["model"],
                "rows": summary["rows"],
                "unique_samples": summary["unique_samples"],
                "hits": summary["hits"],
                "hit_rate": summary["hit_rate"],
                "errors": summary["errors"],
                "warnings": summary["warnings"],
                "hit_sample_ids": ",".join(str(row["sample_id"]) for row in summary["hit_samples"]),
                "error_sample_ids": ",".join(str(row["sample_id"]) for row in summary["error_samples"]),
                "results_path": summary["results_path"],
            }
        )


def _write_sample_rows_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    fieldnames = [
        "sample_id",
        "registered_domain",
        "model_name",
        "success",
        "recovered_domains",
        "contains_warning",
        "response_time",
        "error_type",
        "error_message",
        "raw_response_preview",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            domains = row.get("recovered_domains") or []
            writer.writerow(
                {
                    "sample_id": row.get("sample_id", ""),
                    "registered_domain": row.get("registered_domain", ""),
                    "model_name": row.get("model_name", ""),
                    "success": row.get("success", ""),
                    "recovered_domains": ", ".join(str(item) for item in domains) if isinstance(domains, list) else domains,
                    "contains_warning": row.get("contains_warning", ""),
                    "response_time": row.get("response_time", ""),
                    "error_type": row.get("error_type", ""),
                    "error_message": row.get("error_message", ""),
                    "raw_response_preview": (row.get("raw_response") or "")[:500].replace("\r", " ").replace("\n", " "),
                }
            )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Summarize model benchmark results.")
    parser.add_argument("--outputs-dir", default="outputs", help="Outputs root directory.")
    parser.add_argument("--model", default=None, help="Summarize one model directory only.")
    parser.add_argument("--rewrite", action="store_true", help="Rewrite result files with recalculated hit fields.")
    parser.add_argument("--no-model-files", action="store_true", help="Do not write summary files inside each model directory.")
    parser.add_argument("--summary-json", default=None, help="Summary JSON output path.")
    parser.add_argument("--summary-csv", default=None, help="Summary CSV output path.")
    args = parser.parse_args(argv)
    summary_json = args.summary_json
    summary_csv = args.summary_csv
    if args.model is None:
        summary_json = summary_json or str(Path(args.outputs_dir) / "summary.json")
        summary_csv = summary_csv or str(Path(args.outputs_dir) / "summary.csv")
    report = summarize_outputs(
        SummaryOptions(
            outputs_dir=Path(args.outputs_dir),
            model=args.model,
            rewrite=args.rewrite,
            model_files=not args.no_model_files,
            summary_json=Path(summary_json) if summary_json else None,
            summary_csv=Path(summary_csv) if summary_csv else None,
        )
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
