# LEL Web Experiment

This repository is a streamlined release of the Web AI product automation code used in the paper *LLM Expired Links: Uncovering Expired Domain Risks in the LLM Era*. It is built with Node.js, Playwright, and Chromium, and preserves the original experiment workflow for submitting queries, detecting answer completion with a state machine, collecting response text and HTML evidence, detecting recovered domains, and summarizing results.

The package supports the following Web products:

- ChatGPT
- DeepSeek
- Doubao
- Gemini
- Kimi
- Qwen

Web product interfaces and terms of service may change. Users are responsible for ensuring that their use complies with the applicable platform terms and for updating selectors in `platforms/*.json` when an interface changes.

## Security Notice

This repository does not contain cookies, tokens, accounts, the formal experiment dataset, historical results, HTML evidence, screenshots, or authenticated browser profiles.

Authentication must be completed manually in the browser opened by Playwright. Login state is stored only in the local persistent browser directory `.auth/<platform>/`. This directory may contain sensitive data that can restore an authenticated account session and is excluded by `.gitignore`. Do not upload, archive, share, or commit it.

Response text, HTML, and screenshots may also contain personal information or authentication-page content. Review all generated output before publishing it.

The scripts do not automatically bypass CAPTCHAs, human-verification challenges, platform risk controls, or access controls. In interactive mode, execution pauses and waits for the user to handle such conditions.

## Requirements

- Node.js 18 or later
- npm
- Playwright Chromium
- A usable account for each target platform; users must provide their own accounts and any required subscriptions

Install dependencies and the browser:

```bash
npm ci
npx playwright install chromium
```

List the available platform configurations:

```bash
npm run platforms
```

## Input Format

The input file must use JSONL format. Each line must contain at least the following fields:

```json
{"sample_id":"example-001","registered_domain":"example.org","target_url":"https://example.org/","prompt":"A natural-language query that does not reveal the target domain."}
```

`examples/sample.jsonl` uses the IANA-reserved domain `example.org` only to demonstrate the input format. It is not part of the formal paper dataset and cannot reproduce the reported experiment statistics.

## Login

First, create a local browser profile for the target platform. For example:

```bash
npm run login -- --platform chatgpt
```

After the browser opens, sign in manually and confirm that the chat page is usable. Then return to the terminal and press Enter. For another platform, replace `chatgpt` with `deepseek`, `doubao`, `gemini`, `kimi`, or `qwen`.

Playwright Chromium is used by default. You may explicitly select an installed Chromium-based browser instead:

```bash
npm run login -- --platform chatgpt --browser-channel chrome
npm run login -- --platform chatgpt --browser-executable "/path/to/chromium"
```

Do not commit local browser paths to the repository. Each user should provide them locally through command-line arguments or process environment variables.

## Running an Experiment

Start with one example to verify the page selectors:

```bash
npm run experiment -- --platform chatgpt --input examples/sample.jsonl --run-name chatgpt-example --next 1
```

Run a custom JSONL dataset:

```bash
npm run experiment -- --platform deepseek --input path/to/benchmark.jsonl --run-name deepseek-run
```

All six platforms use the same command structure; only `--platform` changes:

```bash
npm run experiment -- --platform chatgpt --input path/to/benchmark.jsonl --run-name chatgpt
npm run experiment -- --platform deepseek --input path/to/benchmark.jsonl --run-name deepseek
npm run experiment -- --platform doubao --input path/to/benchmark.jsonl --run-name doubao
npm run experiment -- --platform gemini --input path/to/benchmark.jsonl --run-name gemini
npm run experiment -- --platform kimi --input path/to/benchmark.jsonl --run-name kimi
npm run experiment -- --platform qwen --input path/to/benchmark.jsonl --run-name qwen
```

Common options:

- `--next N`: Run the next N unfinished samples.
- `--sample-ids id1,id2`: Run only the specified samples.
- `--no-resume`: Do not skip existing samples; this is usually not recommended.
- `--overwrite-results`: When rerunning, replace the aggregate result, raw file, and evidence for the same `sample_id`.
- `--non-interactive`: Do not wait for manual intervention; record page anomalies as errors.
- `--evidence-sample-rate 1`: Save evidence for every sample. By default, evidence is saved only for hits, failures, or errors.
- `--auth-dir <dir>`: Set the local authentication-profile directory.
- `--browser-channel <channel>` / `--browser-executable <path>`: Select the browser.

Resume behavior is enabled by default. When the same command is rerun with the same `run-name`, input, and output directories, existing `sample_id` values are skipped.

## Answer-Completion State Machine

The automation does not rely only on a fixed delay or on text growth stopping. The state machine jointly checks:

- Whether the answer text is still changing.
- Whether a stop or pause button is still present.
- Whether the page is still thinking, searching, calling a tool, or waiting for authorization.
- Whether the composer is usable again.
- Whether answer action controls such as copy, like, or regenerate are present.
- Whether the answer meets the platform-specific minimum duration, minimum character count, and stability interval.

When a long thinking or search operation reaches a review checkpoint, interactive mode pauses for manual confirmation instead of truncating the answer. Doubao retains limited same-conversation retries after privacy-related refusals. Kimi retains page-level retry handling for peak-load messages and recoverable service errors.

## Output

Default output paths:

```text
result/<run-name>/<run-name>.jsonl
result/<run-name>/raw/<sample_id>.json
evidence/<run-name>/<sample_id>/answer.html
evidence/<run-name>/<sample_id>/page.png
```

Core result fields include:

- `sample_id`
- `platform`
- `prompt`
- `raw_response_text`
- `recovered_domains`
- `success`
- `contains_warning`
- `has_clickable_link`
- `error_type`
- `final_state`
- `completion_reason`
- `manual_review_required`
- `state_summary`

`has_clickable_link` indicates that the answer contains at least one HTTP(S) link; it does not mean that the target domain itself is clickable. `contains_warning` is a keyword-based screening flag and is not equivalent to a manually verified risk warning about the target domain.

Generate a summary for one platform:

```bash
npm run summarize -- --run-name chatgpt-example --input examples/sample.jsonl
```

Generate summaries for all platforms in the result directory:

```bash
npm run summarize:all -- --input path/to/benchmark.jsonl
```

## Optional Environment Variables

`.env.example` lists the available configuration variables. The code reads process environment variables but does not automatically load a `.env` file. Set these variables through the operating system, CI environment, or local shell. Every option can also be supplied through CLI arguments.

## Testing

```bash
npm test
```

The default test suite covers configuration loading, dataset validation, domain extraction, result replacement, and resume logic. After installing Chromium, you can additionally run evidence-saving tests and state-machine tests against a local mock chat page:

```bash
npm run test:browser
```

The browser tests intentionally simulate long thinking periods, tool calls, and manual checkpoints, so they take considerably longer than the default suite. Related tests are skipped when Chromium is unavailable.

## Known Limitations

- Web product DOM structures and interface text change frequently, so selectors require ongoing maintenance.
- Login, CAPTCHAs, permission prompts, and platform risk controls require manual handling.
- Collapsed source panels or lazily loaded links may not be fully captured in the answer-region HTML.
- Platform redirect links are extracted only as their original `href` values; the scripts do not visit them or verify their final destinations.
- Automated warning detection uses keyword rules. Paper-level security conclusions require target-specific association and manual review.
