from __future__ import annotations

import argparse
import asyncio
import json
import re
import shutil
import sys
import time
from pathlib import Path
from typing import Any

from .clients import ProviderError, create_client
from .config import BenchmarkConfig, load_config, safe_path_part
from .domain_matcher import contains_warning, domain_is_recovered, extract_domains


RESULT_FIELDS = (
    "sample_id",
    "registered_domain",
    "model_name",
    "prompt",
    "raw_response",
    "response_time",
    "success",
    "recovered_domains",
    "contains_warning",
    "error_type",
    "error_message",
)

_ACTION_VERB_RE = re.compile(
    r"(?i)(?:search|look\s+up|check|verify|investigate|research|trace|browse|"
    r"检索|搜索|查找|核对|查询|调查|定位|浏览)"
)
_ACTION_LEAD_RE = re.compile(
    r"(?i)^\s*(?:(?:i(?:'ll|\s+will|\s+am\s+going\s+to)|let\s+me|first\s+i(?:'ll|\s+will))\b|"
    r"(?:正在|我(?:将|会|先)|先))"
)


def response_is_incomplete_action(text: str) -> bool:
    """Detect a short agent preamble returned as if it were the final answer."""
    response = str(text or "").strip()
    if not response or len(response) > 400 or extract_domains(response):
        return False
    return bool(_ACTION_LEAD_RE.search(response) and _ACTION_VERB_RE.search(response))


def load_samples(path: str | Path) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    seen_sample_ids: set[str] = set()
    with Path(path).open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            record = json.loads(line)
            for field in ("sample_id", "registered_domain", "target_url", "prompt"):
                if field not in record:
                    raise ValueError(f"line {line_number}: missing {field}")
            sample_id = str(record["sample_id"])
            if sample_id in seen_sample_ids:
                raise ValueError(f"line {line_number}: duplicate sample_id {sample_id}")
            seen_sample_ids.add(sample_id)
            samples.append(record)
    return samples


def load_completed_sample_ids(path: Path, raw_dir: Path | None = None) -> set[str]:
    return load_resume_state(path, raw_dir)["completed_ids"]


def load_resume_state(path: Path, raw_dir: Path | None = None) -> dict[str, Any]:
    if not path.exists():
        return {
            "completed_ids": set(),
            "result_ids": set(),
            "incomplete_ids": set(),
            "bad_json_lines": 0,
        }
    completed: set[str] = set()
    result_ids: set[str] = set()
    incomplete: set[str] = set()
    bad_json_lines = 0
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                bad_json_lines += 1
                continue
            sample_id = record.get("sample_id")
            if sample_id:
                sample_id = str(sample_id)
                result_ids.add(sample_id)
                raw_missing = raw_dir is not None and not (raw_dir / f"{sample_id}.json").exists()
                result_error = bool(record.get("error_type"))
                raw_error = _raw_response_is_error(raw_dir / f"{sample_id}.json") if raw_dir is not None else False
                response_text = str(record.get("raw_response") or "")
                empty_response = not response_text.strip()
                incomplete_action = response_is_incomplete_action(response_text)
                if raw_missing or result_error or raw_error or empty_response or incomplete_action:
                    incomplete.add(sample_id)
                else:
                    completed.add(sample_id)
    return {
        "completed_ids": completed,
        "result_ids": result_ids,
        "incomplete_ids": incomplete,
        "bad_json_lines": bad_json_lines,
    }


async def run_benchmark(config: BenchmarkConfig, dry_run: bool = False, limit: int | None = None) -> dict[str, Any]:
    return await run_selected_benchmark(config, dry_run=dry_run, limit=limit, sample_ids=None)


async def run_selected_benchmark(
    config: BenchmarkConfig,
    dry_run: bool = False,
    limit: int | None = None,
    sample_ids: set[str] | None = None,
    retry_errors: bool = False,
) -> dict[str, Any]:
    if limit is not None and limit < 1:
        raise ValueError("limit must be a positive integer")
    samples = load_samples(config.resolved_benchmark_path)
    output_path = config.resolved_output_path
    raw_dir = config.resolved_raw_response_dir
    error_log_path = output_path.parent / "errors.jsonl"
    error_raw_dir = output_path.parent / "error_raw"
    resume_state = load_resume_state(output_path, raw_dir) if config.resume else {
        "completed_ids": set(),
        "result_ids": set(),
        "incomplete_ids": set(),
        "bad_json_lines": 0,
    }
    completed = resume_state["completed_ids"]
    incomplete_ids = resume_state["incomplete_ids"]
    previous_error_ids = load_error_sample_ids(error_log_path) if config.resume else set()
    pending_samples = [sample for sample in samples if str(sample["sample_id"]) not in completed]
    if sample_ids is not None:
        pending_samples = [sample for sample in pending_samples if str(sample["sample_id"]) in sample_ids]
    if retry_errors or sample_ids is not None:
        schedulable_samples = pending_samples
    else:
        schedulable_samples = [sample for sample in pending_samples if str(sample["sample_id"]) not in previous_error_ids]
    selected_samples = schedulable_samples[:limit] if limit is not None else schedulable_samples

    summary = {
        "benchmark_path": str(config.resolved_benchmark_path),
        "output_path": str(output_path),
        "raw_response_dir": str(raw_dir),
        "error_output_path": str(error_log_path),
        "error_raw_response_dir": str(error_raw_dir),
        "provider": config.provider,
        "model_name": config.model_name,
        "total_samples": len(samples),
        "completed_samples": len(completed),
        "pending_samples": len(pending_samples),
        "previous_error_samples": len(previous_error_ids),
        "schedulable_pending_samples": len(schedulable_samples),
        "selected_samples": len(selected_samples),
        "limit": limit,
        "requested_sample_ids": sorted(sample_ids) if sample_ids is not None else None,
        "retry_errors": retry_errors,
        "concurrency": config.concurrency,
        "max_retries": config.max_retries,
        "dry_run": dry_run,
        "incomplete_result_samples": len(incomplete_ids),
        "incomplete_sample_ids": sorted(incomplete_ids)[:20],
    }
    if dry_run:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return summary

    config.validate_for_run()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    raw_dir.mkdir(parents=True, exist_ok=True)
    error_raw_dir.mkdir(parents=True, exist_ok=True)
    if not config.resume:
        output_path.write_text("", encoding="utf-8")
        error_log_path.write_text("", encoding="utf-8")
    elif incomplete_ids:
        backup_path = repair_incomplete_result_rows(output_path, incomplete_ids, raw_dir)
        summary["resume_repair_backup"] = str(backup_path) if backup_path else None
        _print_progress(
            "REPAIR",
            (
                f"removed_incomplete_results={len(incomplete_ids)} "
                f"backup={backup_path.name if backup_path else 'none'}"
            ),
        )

    client = create_client(config)
    semaphore = asyncio.Semaphore(config.concurrency)
    write_lock = asyncio.Lock()
    progress_lock = asyncio.Lock()
    selected_total = len(selected_samples)
    started_count = 0
    finished_count = 0
    valid_written_count = 0
    hit_count = 0
    error_count = 0

    if selected_total:
        _print_progress(
            "RUN",
            (
                f"model={config.model_name} selected={selected_total} "
                f"completed_before={len(completed)} pending_before={len(pending_samples)} "
                f"concurrency={config.concurrency}"
            ),
        )
    else:
        _print_progress("SKIP", f"model={config.model_name} no pending samples selected")

    async def run_one(sample: dict[str, Any]) -> None:
        nonlocal started_count, finished_count, valid_written_count, hit_count, error_count
        async with semaphore:
            async with progress_lock:
                started_count += 1
                start_index = started_count
                _print_progress("START", f"{start_index}/{selected_total} sample_id={sample['sample_id']}")
            result, raw_payload = await _infer_with_retries(client, config, sample)
            is_error_result = bool(result.get("error_type"))
            if is_error_result:
                await _save_raw_response(error_raw_dir, sample["sample_id"], raw_payload)
                async with write_lock:
                    with error_log_path.open("a", encoding="utf-8", newline="\n") as handle:
                        handle.write(json.dumps(_ordered_result(result), ensure_ascii=False, separators=(",", ":")) + "\n")
            else:
                await _save_raw_response(raw_dir, sample["sample_id"], raw_payload)
                async with write_lock:
                    with output_path.open("a", encoding="utf-8", newline="\n") as handle:
                        handle.write(json.dumps(_ordered_result(result), ensure_ascii=False, separators=(",", ":")) + "\n")
            async with progress_lock:
                finished_count += 1
                if result.get("success") is True:
                    hit_count += 1
                if is_error_result:
                    error_count += 1
                else:
                    valid_written_count += 1
                total_completed = len(completed) + valid_written_count
                remaining = max(0, len(samples) - total_completed)
                status = "hit" if result.get("success") is True else "miss"
                error_type = str(result.get("error_type") or "")
                error_text = f" error={error_type}" if error_type else ""
                _print_progress(
                    "DONE",
                    (
                        f"{finished_count}/{selected_total} sample_id={result['sample_id']} "
                        f"status={status}{error_text} response_time={result.get('response_time')}s "
                        f"batch_hits={hit_count} batch_errors={error_count} "
                        f"total_completed={total_completed}/{len(samples)} remaining={remaining}"
                    ),
                )

    await asyncio.gather(*(run_one(sample) for sample in selected_samples))
    summary["attempted_samples"] = len(selected_samples)
    summary["written_samples"] = valid_written_count
    summary["failed_samples"] = error_count
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return summary


def load_error_sample_ids(path: Path) -> set[str]:
    if not path.exists():
        return set()
    sample_ids: set[str] = set()
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            sample_id = record.get("sample_id")
            if sample_id:
                sample_ids.add(str(sample_id))
    return sample_ids


def repair_incomplete_result_rows(path: Path, incomplete_ids: set[str], raw_dir: Path | None = None) -> Path | None:
    if not incomplete_ids or not path.exists():
        return None
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    backup_path = path.with_name(f"{path.stem}.before-resume-repair.{timestamp}{path.suffix}")
    shutil.copy2(path, backup_path)
    kept_lines: list[str] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                kept_lines.append(line)
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                kept_lines.append(line)
                continue
            sample_id = record.get("sample_id")
            if sample_id and str(sample_id) in incomplete_ids:
                continue
            kept_lines.append(line)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.writelines(kept_lines)
    if raw_dir is not None:
        invalid_raw_dir = path.parent / f"invalid-raw-before-resume-repair.{timestamp}"
        moved_any = False
        for sample_id in sorted(incomplete_ids):
            raw_path = raw_dir / f"{sample_id}.json"
            if raw_path.exists():
                invalid_raw_dir.mkdir(parents=True, exist_ok=True)
                shutil.move(str(raw_path), str(invalid_raw_dir / raw_path.name))
                moved_any = True
        if not moved_any and invalid_raw_dir.exists():
            invalid_raw_dir.rmdir()
    return backup_path


def _raw_response_is_error(path: Path) -> bool:
    if not path.exists():
        return False
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return True
    if not isinstance(raw, dict):
        return False
    return bool(raw.get("error_type") or (raw.get("retryable") is True and raw.get("raw") is None))


def _print_progress(label: str, message: str) -> None:
    timestamp = time.strftime("%H:%M:%S")
    print(f"[{timestamp}] {label} {message}", file=sys.stderr, flush=True)


async def _infer_with_retries(
    client: Any,
    config: BenchmarkConfig,
    sample: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    started = time.perf_counter()
    last_error: ProviderError | None = None
    attempts = config.max_retries + 1
    for attempt in range(1, attempts + 1):
        try:
            if config.system_prompt:
                response = await client.generate(str(sample["prompt"]), system_prompt=config.system_prompt)
            else:
                response = await client.generate(str(sample["prompt"]))
            if not response.text.strip():
                raise ProviderError(
                    "provider_empty_response",
                    "Provider returned no final text response",
                    retryable=True,
                    raw=response.raw,
                )
            if response_is_incomplete_action(response.text):
                raise ProviderError(
                    "provider_incomplete_response",
                    "Provider returned only an action/search preamble without a domain answer",
                    retryable=True,
                    raw=response.raw,
                )
            recovered = extract_domains(response.text)
            result = _base_result(sample, config.model_name)
            result.update(
                {
                    "raw_response": response.text,
                    "response_time": round(response.response_time, 6),
                    "success": domain_is_recovered(str(sample["registered_domain"]), response.text),
                    "recovered_domains": recovered,
                    "contains_warning": contains_warning(response.text),
                    "error_type": "",
                    "error_message": "",
                }
            )
            return result, {"attempt": attempt, "response": response.raw}
        except ProviderError as exc:
            last_error = exc
            if attempt < attempts and exc.retryable:
                await asyncio.sleep(config.retry_backoff_seconds * (2 ** (attempt - 1)))
                continue
            break
        except Exception as exc:  # Defensive: preserve sample accounting for unexpected framework errors.
            last_error = ProviderError("unexpected_error", str(exc), retryable=False)
            break

    elapsed = time.perf_counter() - started
    error = last_error or ProviderError("unknown_error", "Unknown error", retryable=False)
    result = _base_result(sample, config.model_name)
    result.update(
        {
            "raw_response": "",
            "response_time": round(elapsed, 6),
            "success": False,
            "recovered_domains": [],
            "contains_warning": False,
            "error_type": error.error_type,
            "error_message": error.message,
        }
    )
    raw_payload = {
        "error_type": error.error_type,
        "error_message": error.message,
        "retryable": error.retryable,
        "raw": error.raw,
    }
    return result, raw_payload


def _base_result(sample: dict[str, Any], model_name: str) -> dict[str, Any]:
    return {
        "sample_id": str(sample["sample_id"]),
        "registered_domain": str(sample["registered_domain"]),
        "model_name": model_name,
        "prompt": str(sample["prompt"]),
    }


def _ordered_result(result: dict[str, Any]) -> dict[str, Any]:
    return {field: result.get(field) for field in RESULT_FIELDS}


async def _save_raw_response(raw_dir: Path, sample_id: str, payload: dict[str, Any]) -> None:
    path = raw_dir / f"{sample_id}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run Domain Recovery Benchmark inference.")
    parser.add_argument("--config", default="config.yaml", help="Config YAML path.")
    parser.add_argument("--dry-run", action="store_true", help="Validate config/data scheduling without API calls.")
    parser.add_argument("--limit", type=int, default=None, help="Run only the first N pending samples.")
    parser.add_argument("--retry-errors", action="store_true", help="Retry samples already listed in errors.jsonl.")
    args = parser.parse_args(argv)
    config = load_config(args.config)
    asyncio.run(run_selected_benchmark(config, dry_run=args.dry_run, limit=args.limit, retry_errors=args.retry_errors))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
