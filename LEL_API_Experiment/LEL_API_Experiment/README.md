# LEL API Experiment

This directory contains the sanitized API evaluation code used for the LLM Expired Links (LEL) study. It implements model-provider adapters, concurrent batch inference, retry and resume behavior, raw-response preservation, domain extraction and matching, and result summarization.

The publication package intentionally excludes the paper's 3,000-query benchmark, model outputs, logs, API credentials, private gateway addresses, and intermediate analysis files. A two-row synthetic example is included for offline validation.

## Included functionality

- OpenAI-compatible Chat Completions adapter.
- OpenAI Responses API adapter, including streamed SSE response parsing.
- Anthropic-compatible Messages adapter.
- Gemini-compatible `generateContent` adapter.
- Asynchronous batch execution with per-model concurrency limits.
- Timeouts, retryable HTTP/network error handling, exponential backoff, and checkpoint resume.
- Separate storage for valid results, failed requests, and raw provider payloads.
- URL/domain extraction, normalization, exact target-domain matching, and keyword warning flags.
- Error reruns, input validation, and per-model/global summaries.

The code uses direct HTTP requests rather than vendor SDKs.

## Project layout

```text
LEL_API_Experiment/
|-- .env.example
|-- .gitignore
|-- README.md
|-- requirements.txt
|-- configs/
|   |-- claude-sonnet-4-6.yaml
|   |-- deepseek-v4-pro.yaml
|   |-- gemini-3.1-pro-preview.yaml
|   |-- glm-5.1.yaml
|   |-- gpt-5.4.yaml
|   |-- gpt-5.5.yaml
|   |-- gpt-5.6-sol.yaml
|   |-- grok-4.5.yaml
|   `-- kimi-k2.6.yaml
|-- domain_benchmark/
|   |-- __init__.py
|   |-- clients.py
|   |-- config.py
|   |-- domain_matcher.py
|   |-- rerun_errors.py
|   |-- run.py
|   |-- runner.py
|   |-- summarize.py
|   `-- validate_data.py
`-- examples/
    `-- benchmark.example.jsonl
```

## Requirements

- Python 3.10 or later.
- Network access to a compatible API provider for real inference.

Install dependencies:

```bash
python -m venv .venv
python -m pip install -r requirements.txt
```

## Credentials and endpoints

The repository does not load `.env` automatically. Use `.env.example` only as a template and set the variables in the process environment before running a real request.

PowerShell example:

```powershell
$env:LEL_OPENAI_BASE_URL = "https://your-provider.example/v1"
$env:LEL_OPENAI_API_KEY = "your-api-key"
```

Bash example:

```bash
export LEL_OPENAI_BASE_URL="https://your-provider.example/v1"
export LEL_OPENAI_API_KEY="your-api-key"
```

Anthropic-compatible configurations use `LEL_ANTHROPIC_BASE_URL` and `LEL_ANTHROPIC_API_KEY`. Gemini-compatible configurations use `LEL_GEMINI_BASE_URL` and `LEL_GEMINI_API_KEY`.

Never commit a populated `.env` file. `.gitignore` excludes `.env`, outputs, logs, caches, archives, and temporary files.

## Model configurations

The included model identifiers reproduce the experiment configuration:

| Config | Provider adapter |
|---|---|
| `claude-sonnet-4-6.yaml` | `anthropic_compatible` |
| `deepseek-v4-pro.yaml` | `openai_compatible` |
| `gemini-3.1-pro-preview.yaml` | `gemini_compatible` |
| `glm-5.1.yaml` | `openai_compatible` |
| `gpt-5.4.yaml` | `openai_compatible` |
| `gpt-5.5.yaml` | `openai_compatible` |
| `gpt-5.6-sol.yaml` | `openai_compatible` |
| `grok-4.5.yaml` | `openai_compatible` |
| `kimi-k2.6.yaml` | `openai_compatible` |

Model aliases and availability are provider-specific. Change `model_name` only when the selected provider documents a different identifier. If a provider requires the OpenAI Responses endpoint, set `provider: "openai_responses"` in that model's YAML file.

An unset `temperature` or `max_tokens` is not transmitted and therefore uses the provider default. The Anthropic adapter retains the original implementation's fallback of 1,024 output tokens when `max_tokens` is unset.

No configuration enables Web search, browsing, or external tools. The Grok configuration retains the experiment's explicit instruction to answer from existing knowledge and not invoke tools.

## Input format

The runner expects UTF-8 JSONL with exactly one sample per line:

```json
{"sample_id":"000001","registered_domain":"example.org","target_url":"https://example.org/","prompt":"Which registered domain is associated with the reserved Example Domain page used in documentation? Return the domain name."}
```

Only `prompt` is sent to the model. `registered_domain` and `target_url` remain local ground truth. Replace the example file path in a config only when using a separately obtained benchmark.

Validate the included example:

```bash
python -m domain_benchmark.validate_data --input examples/benchmark.example.jsonl --expected-rows 2
```

## Running the benchmark

Check scheduling and paths without making network requests:

```bash
python -m domain_benchmark.run --config configs/gpt-5.4.yaml --dry-run
```

Run a small batch:

```bash
python -m domain_benchmark.run --config configs/gpt-5.4.yaml --limit 2
```

Run all pending samples:

```bash
python -m domain_benchmark.run --config configs/gpt-5.4.yaml
```

With `resume: true`, valid samples already present in `results.jsonl` are skipped. Samples in `errors.jsonl` are not retried by a normal resume run unless `--retry-errors` is supplied.

Preview and rerun failed samples:

```bash
python -m domain_benchmark.rerun_errors --config configs/gpt-5.4.yaml --dry-run
python -m domain_benchmark.rerun_errors --config configs/gpt-5.4.yaml
```

## Outputs

Each model writes to `outputs/<model_name>/`:

- `results.jsonl`: valid model responses, including misses.
- `raw/<sample_id>.json`: raw provider payload for each valid response.
- `errors.jsonl`: final request failures after retries.
- `error_raw/<sample_id>.json`: raw error metadata.

Result rows retain the experiment field names:

- `sample_id`
- `registered_domain`
- `model_name`
- `prompt` (the question sent to the model)
- `raw_response` (the extracted response text)
- `response_time`
- `success` (target-domain hit, not API request success)
- `recovered_domains`
- `contains_warning`
- `error_type`
- `error_message`

A valid `success: false` row is an API response that did not recover the target. Transport/provider failures are written to `errors.jsonl` instead.

Summarize one model or all model directories:

```bash
python -m domain_benchmark.summarize --outputs-dir outputs --model gpt-5.4
python -m domain_benchmark.summarize --outputs-dir outputs
```

Do not use `--rewrite` when auditing immutable experiment outputs; that option recalculates and rewrites derived hit fields.

## Matching and warning rules

The matcher extracts URLs and bare domains, removes schemes, paths, ports, trailing punctuation, and a leading `www.`, lowercases the host, and applies IDNA conversion. A hit requires exact equality between an extracted normalized host and the normalized `registered_domain`.

The implementation intentionally preserves the experiment logic. It does not use the Public Suffix List and does not collapse arbitrary subdomains to registrable domains. The retained plausibility heuristic can reject unusual two-label domains whose first label is a common second-level label, such as `gov.gd`; downstream analyses should document any manual correction rather than silently changing the matcher.

`contains_warning` is a broad keyword flag for phrases such as domain expiration or site unavailability. It is not target-aware and is not equivalent to the paper's later contextual risk-warning labels. Those labels and the formal experiment outputs are not included in this release package.

## Reproducibility and limitations

- Gateway-side system prompts, routing, model substitutions, or hidden tools cannot be verified by this client.
- Model names are provider aliases rather than cryptographically verifiable model builds.
- API responses and timing can vary by provider and collection date.
- Credentials and private gateway URLs have been removed.
- The formal benchmark and original model responses must be released separately if permitted.
- No software license is included because license selection must be made by the repository owner before public distribution.
