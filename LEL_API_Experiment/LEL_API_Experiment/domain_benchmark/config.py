from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


_ENV_PATTERN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}")


@dataclass(frozen=True)
class BenchmarkConfig:
    provider: str = "openai_compatible"
    base_url: str = ""
    api_key: str = ""
    model_name: str = ""
    benchmark_path: str = "benchmark.jsonl"
    output_dir: str = "outputs"
    output_path: str | None = None
    raw_response_dir: str | None = None
    concurrency: int = 4
    timeout_seconds: float = 60.0
    max_retries: int = 2
    retry_backoff_seconds: float = 1.0
    resume: bool = True
    max_tokens: int | None = None
    temperature: float | None = None
    system_prompt: str | None = None
    anthropic_version: str = "2023-06-01"
    request_options: dict[str, Any] = field(default_factory=dict)
    config_dir: Path = field(default_factory=lambda: Path.cwd())

    @classmethod
    def from_mapping(cls, data: dict[str, Any], config_dir: Path | None = None) -> "BenchmarkConfig":
        values = dict(data)
        config_dir = config_dir or Path.cwd()
        return cls(
            provider=str(values.get("provider", cls.provider)).strip(),
            base_url=_expand_env(str(values.get("base_url", cls.base_url))).strip(),
            api_key=_expand_env(str(values.get("api_key", ""))),
            model_name=str(values.get("model_name", cls.model_name)).strip(),
            benchmark_path=str(values.get("benchmark_path", cls.benchmark_path)).strip(),
            output_dir=str(values.get("output_dir", cls.output_dir)).strip(),
            output_path=_optional_str(values.get("output_path")),
            raw_response_dir=_optional_str(values.get("raw_response_dir")),
            concurrency=max(1, int(values.get("concurrency", cls.concurrency))),
            timeout_seconds=float(values.get("timeout_seconds", cls.timeout_seconds)),
            max_retries=max(0, int(values.get("max_retries", cls.max_retries))),
            retry_backoff_seconds=max(0.0, float(values.get("retry_backoff_seconds", cls.retry_backoff_seconds))),
            resume=bool(values.get("resume", cls.resume)),
            max_tokens=_optional_int(values.get("max_tokens")),
            temperature=_optional_float(values.get("temperature")),
            system_prompt=_optional_str(values.get("system_prompt")),
            anthropic_version=str(values.get("anthropic_version", cls.anthropic_version)).strip(),
            request_options=dict(values.get("request_options") or {}),
            config_dir=config_dir,
        )

    def resolve_path(self, value: str) -> Path:
        path = Path(value)
        if path.is_absolute():
            return path
        return (self.config_dir / path).resolve()

    @property
    def resolved_benchmark_path(self) -> Path:
        return self.resolve_path(self.benchmark_path)

    @property
    def model_output_dir(self) -> Path:
        return self.resolve_path(self.output_dir) / safe_path_part(self.model_name)

    @property
    def resolved_output_path(self) -> Path:
        if self.output_path is None:
            return self.model_output_dir / "results.jsonl"
        return self.resolve_path(self.output_path)

    @property
    def resolved_raw_response_dir(self) -> Path:
        if self.raw_response_dir is None:
            return self.model_output_dir / "raw"
        return self.resolve_path(self.raw_response_dir)

    def validate_for_run(self) -> None:
        if self.provider not in {"openai_compatible", "openai_responses", "anthropic_compatible", "gemini_compatible"}:
            raise ValueError(
                "provider must be openai_compatible, openai_responses, anthropic_compatible, or gemini_compatible"
            )
        if not self.base_url:
            raise ValueError("base_url is required")
        if not self.model_name:
            raise ValueError("model_name is required")
        if not self.api_key:
            raise ValueError("api_key is required for real API runs; set the environment variable referenced by config")


def load_config(path: str | Path) -> BenchmarkConfig:
    config_path = Path(path).resolve()
    data = _load_yaml_mapping(config_path)
    return BenchmarkConfig.from_mapping(data, config_path.parent)


def _load_yaml_mapping(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    try:
        import yaml  # type: ignore

        loaded = yaml.safe_load(text) or {}
        if not isinstance(loaded, dict):
            raise ValueError("config.yaml must contain a top-level mapping")
        return loaded
    except ModuleNotFoundError:
        return _simple_yaml_load(text)


def _simple_yaml_load(text: str) -> dict[str, Any]:
    """Small fallback parser for this repository's flat config template."""
    data: dict[str, Any] = {}
    current_map_key: str | None = None
    for raw_line in text.splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        line = raw_line.strip()
        if indent and current_map_key:
            key, value = _split_yaml_pair(line)
            if not isinstance(data.get(current_map_key), dict):
                data[current_map_key] = {}
            data[current_map_key][key] = _parse_scalar(value)
            continue
        key, value = _split_yaml_pair(line)
        if value == "":
            data[key] = None
            current_map_key = key
        else:
            data[key] = _parse_scalar(value)
            current_map_key = None
    return data


def _split_yaml_pair(line: str) -> tuple[str, str]:
    if ":" not in line:
        raise ValueError(f"Invalid config line: {line}")
    key, value = line.split(":", 1)
    return key.strip(), value.strip()


def _parse_scalar(value: str) -> Any:
    if value == "":
        return ""
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    lowered = value.lower()
    if lowered in {"true", "false"}:
        return lowered == "true"
    if lowered in {"null", "none", "~"}:
        return None
    try:
        if "." in value:
            return float(value)
        return int(value)
    except ValueError:
        return value


def _expand_env(value: str) -> str:
    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        default = match.group(2) or ""
        return os.environ.get(name, default)

    return _ENV_PATTERN.sub(replace, value)


def _optional_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    return int(value)


def _optional_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    return float(value)


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def safe_path_part(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip())
    return cleaned or "model"
