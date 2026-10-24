from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request

from .config import BenchmarkConfig


@dataclass
class ProviderResponse:
    text: str
    raw: dict[str, Any]
    response_time: float


class ProviderError(Exception):
    def __init__(self, error_type: str, message: str, retryable: bool = False, raw: Any = None) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message
        self.retryable = retryable
        self.raw = raw


class ProviderHTTPError(ProviderError):
    def __init__(self, status_code: int, body: str) -> None:
        retryable = status_code == 429 or 500 <= status_code <= 599
        body_preview = body[:2000]
        super().__init__(
            error_type=f"http_{status_code}",
            message=f"HTTP {status_code}: {body_preview}",
            retryable=retryable,
            raw={"status_code": status_code, "body": body_preview},
        )
        self.status_code = status_code


class BaseClient:
    def __init__(self, config: BenchmarkConfig) -> None:
        self.config = config

    async def generate(self, prompt: str, system_prompt: str | None = None) -> ProviderResponse:
        raise NotImplementedError


class OpenAICompatibleClient(BaseClient):
    async def generate(self, prompt: str, system_prompt: str | None = None) -> ProviderResponse:
        httpx = _load_httpx()
        endpoint = _v1_endpoint(self.config.base_url, "/chat/completions")
        messages: list[dict[str, str]] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})
        payload: dict[str, Any] = {
            "model": self.config.model_name,
            "messages": messages,
        }
        if self.config.max_tokens is not None:
            payload["max_tokens"] = self.config.max_tokens
        if self.config.temperature is not None:
            payload["temperature"] = self.config.temperature
        payload.update(self.config.request_options)
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.config.api_key}",
        }
        return await _post_json(httpx, endpoint, headers, payload, self.config.timeout_seconds, _extract_openai_text)


class OpenAIResponsesClient(BaseClient):
    async def generate(self, prompt: str, system_prompt: str | None = None) -> ProviderResponse:
        httpx = _load_httpx()
        endpoint = _v1_endpoint(self.config.base_url, "/responses")
        payload: dict[str, Any] = {
            "model": self.config.model_name,
            "input": prompt,
            "stream": True,
        }
        if system_prompt:
            payload["instructions"] = system_prompt
        if self.config.max_tokens is not None:
            payload["max_output_tokens"] = self.config.max_tokens
        if self.config.temperature is not None:
            payload["temperature"] = self.config.temperature
        payload.update(self.config.request_options)
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.config.api_key}",
        }
        return await _post_openai_responses(httpx, endpoint, headers, payload, self.config.timeout_seconds)


class AnthropicCompatibleClient(BaseClient):
    async def generate(self, prompt: str, system_prompt: str | None = None) -> ProviderResponse:
        httpx = _load_httpx()
        endpoint = _v1_endpoint(self.config.base_url, "/messages")
        payload: dict[str, Any] = {
            "model": self.config.model_name,
            "max_tokens": self.config.max_tokens or 1024,
            "messages": [{"role": "user", "content": prompt}],
        }
        if system_prompt:
            payload["system"] = system_prompt
        if self.config.temperature is not None:
            payload["temperature"] = self.config.temperature
        payload.update(self.config.request_options)
        headers = {
            "Content-Type": "application/json",
            "x-api-key": self.config.api_key,
            "anthropic-version": self.config.anthropic_version,
        }
        return await _post_json(httpx, endpoint, headers, payload, self.config.timeout_seconds, _extract_anthropic_text)


class GeminiCompatibleClient(BaseClient):
    async def generate(self, prompt: str, system_prompt: str | None = None) -> ProviderResponse:
        httpx = _load_httpx()
        endpoint = _gemini_endpoint(self.config.base_url, self.config.model_name)
        payload: dict[str, Any] = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        }
        if system_prompt:
            payload["systemInstruction"] = {"parts": [{"text": system_prompt}]}
        generation_config: dict[str, Any] = {}
        if self.config.max_tokens is not None:
            generation_config["maxOutputTokens"] = self.config.max_tokens
        if self.config.temperature is not None:
            generation_config["temperature"] = self.config.temperature
        if generation_config:
            payload["generationConfig"] = generation_config
        payload.update(self.config.request_options)
        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": self.config.api_key,
        }
        return await _post_json(httpx, endpoint, headers, payload, self.config.timeout_seconds, _extract_gemini_text)


def create_client(config: BenchmarkConfig) -> BaseClient:
    if config.provider == "openai_compatible":
        return OpenAICompatibleClient(config)
    if config.provider == "openai_responses":
        return OpenAIResponsesClient(config)
    if config.provider == "anthropic_compatible":
        return AnthropicCompatibleClient(config)
    if config.provider == "gemini_compatible":
        return GeminiCompatibleClient(config)
    raise ValueError("provider must be openai_compatible, openai_responses, anthropic_compatible, or gemini_compatible")


def _load_httpx() -> Any:
    try:
        import httpx  # type: ignore

        return httpx
    except ModuleNotFoundError:
        return None


def _v1_endpoint(base_url: str, endpoint: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/v1"):
        return f"{base}{endpoint}"
    return f"{base}/v1{endpoint}"


def _gemini_endpoint(base_url: str, model_name: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/v1beta"):
        versioned = base
    else:
        versioned = f"{base}/v1beta"
    return f"{versioned}/models/{model_name}:generateContent"


async def _post_json(
    httpx: Any,
    endpoint: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout_seconds: float,
    text_extractor: Any,
) -> ProviderResponse:
    if httpx is None:
        return await _post_json_urllib(endpoint, headers, payload, timeout_seconds, text_extractor)

    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.post(endpoint, headers=headers, json=payload)
    except httpx.TimeoutException as exc:
        return await _post_json_curl_or_raise(
            endpoint,
            headers,
            payload,
            timeout_seconds,
            text_extractor,
            ProviderError("timeout", _exception_message(exc), retryable=True),
        )
    except httpx.RequestError as exc:
        return await _post_json_curl_or_raise(
            endpoint,
            headers,
            payload,
            timeout_seconds,
            text_extractor,
            ProviderError("network_error", _exception_message(exc), retryable=True),
        )

    elapsed = time.perf_counter() - started
    if response.status_code >= 400:
        raise ProviderHTTPError(response.status_code, response.text)
    try:
        raw = response.json()
    except json.JSONDecodeError as exc:
        raise ProviderError("invalid_json", response.text[:2000], retryable=False) from exc
    return ProviderResponse(text=text_extractor(raw), raw=raw, response_time=elapsed)


async def _post_openai_responses(
    httpx: Any,
    endpoint: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout_seconds: float,
) -> ProviderResponse:
    if httpx is None:
        return await _post_openai_responses_urllib(endpoint, headers, payload, timeout_seconds)

    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.post(endpoint, headers=headers, json=payload)
    except httpx.TimeoutException as exc:
        return await _post_openai_responses_curl_or_raise(
            endpoint,
            headers,
            payload,
            timeout_seconds,
            ProviderError("timeout", _exception_message(exc), retryable=True),
        )
    except httpx.RequestError as exc:
        return await _post_openai_responses_curl_or_raise(
            endpoint,
            headers,
            payload,
            timeout_seconds,
            ProviderError("network_error", _exception_message(exc), retryable=True),
        )

    elapsed = time.perf_counter() - started
    if response.status_code >= 400:
        raise ProviderHTTPError(response.status_code, response.text)
    text, raw = _parse_openai_responses_body(response.text)
    return ProviderResponse(text=text, raw=raw, response_time=elapsed)


async def _post_json_urllib(
    endpoint: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout_seconds: float,
    text_extractor: Any,
) -> ProviderResponse:
    import asyncio

    return await asyncio.to_thread(_post_json_urllib_sync, endpoint, headers, payload, timeout_seconds, text_extractor)


async def _post_openai_responses_urllib(
    endpoint: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout_seconds: float,
) -> ProviderResponse:
    import asyncio

    return await asyncio.to_thread(_post_openai_responses_urllib_sync, endpoint, headers, payload, timeout_seconds)


def _post_json_urllib_sync(
    endpoint: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout_seconds: float,
    text_extractor: Any,
) -> ProviderResponse:
    started = time.perf_counter()
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib_request.Request(endpoint, data=body, headers=headers, method="POST")
    try:
        with urllib_request.urlopen(request, timeout=timeout_seconds) as response:
            raw_text = response.read().decode("utf-8")
            status_code = response.status
    except urllib_error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise ProviderHTTPError(exc.code, error_body) from exc
    except TimeoutError as exc:
        return _post_json_curl_sync_or_raise(
            endpoint,
            headers,
            payload,
            timeout_seconds,
            text_extractor,
            ProviderError("timeout", _exception_message(exc), retryable=True),
        )
    except urllib_error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        error_type = "timeout" if isinstance(reason, TimeoutError) else "network_error"
        return _post_json_curl_sync_or_raise(
            endpoint,
            headers,
            payload,
            timeout_seconds,
            text_extractor,
            ProviderError(error_type, str(reason), retryable=True),
        )

    elapsed = time.perf_counter() - started
    if status_code >= 400:
        raise ProviderHTTPError(status_code, raw_text)
    try:
        raw = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise ProviderError("invalid_json", raw_text[:2000], retryable=False) from exc
    return ProviderResponse(text=text_extractor(raw), raw=raw, response_time=elapsed)


def _post_openai_responses_urllib_sync(
    endpoint: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout_seconds: float,
) -> ProviderResponse:
    started = time.perf_counter()
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib_request.Request(endpoint, data=body, headers=headers, method="POST")
    try:
        with urllib_request.urlopen(request, timeout=timeout_seconds) as response:
            raw_text = response.read().decode("utf-8")
            status_code = response.status
    except urllib_error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise ProviderHTTPError(exc.code, error_body) from exc
    except TimeoutError as exc:
        return _post_openai_responses_curl_sync_or_raise(
            endpoint,
            headers,
            payload,
            timeout_seconds,
            ProviderError("timeout", _exception_message(exc), retryable=True),
        )
    except urllib_error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        error_type = "timeout" if isinstance(reason, TimeoutError) else "network_error"
        return _post_openai_responses_curl_sync_or_raise(
            endpoint,
            headers,
            payload,
            timeout_seconds,
            ProviderError(error_type, str(reason), retryable=True),
        )

    elapsed = time.perf_counter() - started
    if status_code >= 400:
        raise ProviderHTTPError(status_code, raw_text)
    text, raw = _parse_openai_responses_body(raw_text)
    return ProviderResponse(text=text, raw=raw, response_time=elapsed)


async def _post_json_curl_or_raise(
    endpoint: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout_seconds: float,
    text_extractor: Any,
    original_error: ProviderError,
) -> ProviderResponse:
    import asyncio

    return await asyncio.to_thread(
        _post_json_curl_sync_or_raise,
        endpoint,
        headers,
        payload,
        timeout_seconds,
        text_extractor,
        original_error,
    )


async def _post_openai_responses_curl_or_raise(
    endpoint: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout_seconds: float,
    original_error: ProviderError,
) -> ProviderResponse:
    import asyncio

    return await asyncio.to_thread(
        _post_openai_responses_curl_sync_or_raise,
        endpoint,
        headers,
        payload,
        timeout_seconds,
        original_error,
    )


def _post_json_curl_sync_or_raise(
    endpoint: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout_seconds: float,
    text_extractor: Any,
    original_error: ProviderError,
) -> ProviderResponse:
    curl_path = shutil.which("curl.exe") or shutil.which("curl")
    if not curl_path:
        raise original_error
    return _post_json_curl_sync(curl_path, endpoint, headers, payload, timeout_seconds, text_extractor)


def _post_openai_responses_curl_sync_or_raise(
    endpoint: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout_seconds: float,
    original_error: ProviderError,
) -> ProviderResponse:
    curl_path = shutil.which("curl.exe") or shutil.which("curl")
    if not curl_path:
        raise original_error
    return _post_openai_responses_curl_sync(curl_path, endpoint, headers, payload, timeout_seconds)


def _post_json_curl_sync(
    curl_path: str,
    endpoint: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout_seconds: float,
    text_extractor: Any,
) -> ProviderResponse:
    raw_text, status_code, elapsed = _post_curl_raw_sync(curl_path, endpoint, headers, payload, timeout_seconds)
    if status_code >= 400:
        raise ProviderHTTPError(status_code, raw_text)
    try:
        raw = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise ProviderError("invalid_json", raw_text[:2000], retryable=False) from exc
    return ProviderResponse(text=text_extractor(raw), raw=raw, response_time=elapsed)


def _post_openai_responses_curl_sync(
    curl_path: str,
    endpoint: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout_seconds: float,
) -> ProviderResponse:
    raw_text, status_code, elapsed = _post_curl_raw_sync(curl_path, endpoint, headers, payload, timeout_seconds)
    if status_code >= 400:
        raise ProviderHTTPError(status_code, raw_text)
    text, raw = _parse_openai_responses_body(raw_text)
    return ProviderResponse(text=text, raw=raw, response_time=elapsed)


def _post_curl_raw_sync(
    curl_path: str,
    endpoint: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout_seconds: float,
) -> tuple[str, int, float]:
    started = time.perf_counter()
    payload_path: str | None = None
    config_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False) as payload_file:
            json.dump(payload, payload_file, ensure_ascii=False)
            payload_path = payload_file.name

        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".curl", delete=False) as config_file:
            config_path = config_file.name
            config_file.write(f'url = "{_curl_quote(endpoint)}"\n')
            config_file.write('request = "POST"\n')
            config_file.write("silent\n")
            config_file.write("show-error\n")
            config_file.write(f"max-time = {max(1, int(timeout_seconds))}\n")
            config_file.write(f"connect-timeout = {min(20, max(1, int(timeout_seconds)))}\n")
            config_file.write('output = "-"\n')
            config_file.write('write-out = "\\n%{http_code}"\n')
            for key, value in headers.items():
                config_file.write(f'header = "{_curl_quote(f"{key}: {value}")}"\n')
            config_file.write(f'data-binary = "@{_curl_quote(Path(payload_path).as_posix())}"\n')

        completed = subprocess.run(
            [curl_path, "--config", config_path],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds + 5,
            check=False,
        )
        if completed.returncode != 0:
            message = (completed.stderr or completed.stdout or f"curl exited with {completed.returncode}").strip()
            raise ProviderError("network_error", message, retryable=True)
        raw_output = completed.stdout
        if "\n" not in raw_output:
            raise ProviderError("invalid_response", raw_output[:2000], retryable=False)
        raw_text, status_text = raw_output.rsplit("\n", 1)
        try:
            status_code = int(status_text.strip())
        except ValueError as exc:
            raise ProviderError("invalid_status", status_text[:2000], retryable=False) from exc
        elapsed = time.perf_counter() - started
        return raw_text, status_code, elapsed
    finally:
        for path in (payload_path, config_path):
            if path:
                try:
                    os.remove(path)
                except OSError:
                    pass


def _curl_quote(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _exception_message(exc: BaseException) -> str:
    message = str(exc)
    return message if message else repr(exc)


def _extract_openai_text(raw: dict[str, Any]) -> str:
    choices = raw.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    content = message.get("content", "")
    return _content_to_text(content)


def _parse_openai_responses_body(body: str) -> tuple[str, dict[str, Any]]:
    if _looks_like_sse(body):
        events = _parse_sse_events(body)
        return _extract_openai_responses_stream_text(events), {"events": events}
    try:
        raw = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ProviderError("invalid_json", body[:2000], retryable=False) from exc
    return _extract_openai_responses_text(raw), raw


def _looks_like_sse(body: str) -> bool:
    return any(line.lstrip().startswith("data:") for line in body.splitlines())


def _parse_sse_events(body: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped.startswith("data:"):
            continue
        data = stripped[5:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            parsed = json.loads(data)
        except json.JSONDecodeError:
            parsed = {"_raw": data}
        if isinstance(parsed, dict):
            events.append(parsed)
        else:
            events.append({"data": parsed})
    return events


def _extract_openai_responses_stream_text(events: list[dict[str, Any]]) -> str:
    deltas: list[str] = []
    completed_text = ""
    for event in events:
        event_type = str(event.get("type", ""))
        if event_type == "response.output_text.delta":
            deltas.append(str(event.get("delta", "")))
            continue
        if event_type == "response.completed":
            response = event.get("response")
            if isinstance(response, dict):
                completed_text = _extract_openai_responses_text(response)
    joined = "".join(deltas)
    return joined or completed_text


def _extract_openai_responses_text(raw: dict[str, Any]) -> str:
    if isinstance(raw.get("response"), dict):
        return _extract_openai_responses_text(raw["response"])
    if "output_text" in raw:
        return _content_to_text(raw.get("output_text"))
    output = raw.get("output")
    if isinstance(output, list):
        parts: list[str] = []
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if isinstance(content, list):
                for content_item in content:
                    if isinstance(content_item, dict) and "text" in content_item:
                        parts.append(str(content_item.get("text", "")))
            elif content:
                parts.append(_content_to_text(content))
        text = "\n".join(part for part in parts if part)
        if text:
            return text
    if "choices" in raw:
        return _extract_openai_text(raw)
    return ""


def _extract_anthropic_text(raw: dict[str, Any]) -> str:
    content = raw.get("content", "")
    tool_names: list[str] = []
    if isinstance(content, list):
        for item in content:
            if not isinstance(item, dict) or item.get("type") != "tool_use":
                continue
            name = str(item.get("name") or "unknown_tool")
            if name not in tool_names:
                tool_names.append(name)

    if raw.get("stop_reason") == "tool_use" or tool_names:
        tools = ", ".join(tool_names) if tool_names else "unknown_tool"
        raise ProviderError(
            "provider_route_error",
            f"Anthropic response requested unsupported tools ({tools}); "
            "the upstream provider routed this benchmark request to a tool-use context",
            retryable=True,
            raw=raw,
        )
    return _content_to_text(content)


def _extract_gemini_text(raw: dict[str, Any]) -> str:
    candidates = raw.get("candidates") or []
    if not candidates:
        return ""
    content = candidates[0].get("content") or {}
    parts = content.get("parts") or []
    return _content_to_text(parts)


def _content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if "text" in item:
                    parts.append(str(item["text"]))
                elif item.get("type") == "text":
                    parts.append(str(item.get("content", "")))
        return "\n".join(part for part in parts if part)
    return str(content or "")
