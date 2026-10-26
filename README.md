# LLM Expired Links (LEL): Evaluation Benchmarks and Experimental Scripts

This repository provides the evaluation query datasets and experimental scripts for the paper **LLM Expired Links: Uncovering Expired Domain Risks in the LLM Era**.

LLM Expired Links (LEL) describes a potential security risk in which large language models return expired domain names that were historically associated with legitimate entities when answering user questions, potentially directing users to Web resources that are defunct, have changed purpose, or are no longer trustworthy. This repository supports research into the occurrence of target domains in model responses, the ways in which related links are presented, and the accompanying risk warnings.

## 1. Repository Contents

| Path | Description |
|---|---|
| `API-Benchmark-3000.jsonl` | 3,000 natural-language queries for the API-based experiments, associated with 2,831 distinct target domains. |
| `Web-Benchmark-1000.jsonl` | 1,000 natural-language queries for the Web-based experiments, associated with 842 distinct target domains. |
| `LEL_API_Experiment/LEL_API_Experiment/` | API experiment code, model configurations, example inputs, and usage instructions. |
| `LEL_Web_Experiment/LEL_Web_Experiment/` | Web product experiment code, platform configurations, example inputs, and usage instructions. |
| `Prompt/Question_generation_prompt.md` | The prompt used to generate the natural-language test queries. |

The API-based and Web-based experiments use different interaction and result-collection procedures and therefore have separate implementations. The experimental code in this anonymous repository is organized into separate directories.

## 2. Dataset Description

The evaluation datasets were constructed from historical external links and their surrounding context in the English and Chinese editions of Wikipedia. DNS and WHOIS information was used to identify candidate expired domains, and GPT-5 was then used to generate natural-language queries from historical page information and contextual evidence.

Each query is associated with one target domain for evaluation. The query text does not reveal the target domain or URL, allowing us to observe whether a model recovers and outputs the corresponding historically associated domain from a natural-language question.

Both data files use UTF-8-encoded JSONL format, with one JSON object per line:

| Field | Description |
|---|---|
| `sample_id` | The sample identifier within the current data file. |
| `registered_domain` | The target domain used for result matching. |
| `target_url` | The target URL associated with the sample, stored as evaluation metadata. |
| `prompt` | The natural-language question submitted to the model or Web product. |

The target domain and target URL are local evaluation metadata and should not be appended to the question submitted to the model. A model request may also include a system prompt explicitly specified in its configuration file; refer to the configuration used for the particular run.

When records are compared by target domain, target URL, and query text, all 1,000 queries in the Web dataset are contained in the 3,000-query API dataset. The two files differ in size, and their sample identifiers should not be assumed to be shared across files. When reproducing the experiments, preserve the original identifiers and record contents in each file. When comparing the two datasets, establish correspondences from the actual record contents.

This repository releases the two selected test sets described above. It does not include all 10,000 generated queries or the complete intermediate materials used to construct the datasets.

## 3. API-Based Experiments

The API experiment code uses direct HTTP requests and protocol-specific adapters to support batch querying, concurrency control, timeout handling and retries, resumable execution, raw-response storage, and result aggregation.

The code includes adapters for OpenAI-compatible Chat Completions, OpenAI Responses, Anthropic-compatible Messages, and Gemini-compatible `generateContent`. Before running an experiment, configure an accessible service endpoint, a model identifier, and your own API credentials.

For dependency installation, input-file configuration, environment variables, and execution commands, see:

[API Experiment Instructions](LEL_API_Experiment/LEL_API_Experiment/README.md)

For a formal evaluation run, set the input path in the configuration to `API-Benchmark-3000.jsonl` in the repository root. The small synthetic samples in the subdirectory are provided only to check the input format and program workflow; they are not a substitute for the formal evaluation set used in the paper. Model identifiers in the public configurations are interpreted by the corresponding service provider.

## 4. Web-Based Product Experiments

The Web experiment code uses Node.js, Playwright, and Chromium and supports ChatGPT, DeepSeek, Doubao, Gemini, Kimi, and Qwen.

The program submits queries, determines whether a response has completed, and saves response text, HTML, screenshots, and status information according to the run configuration. The person running the experiment must complete platform login and handle page states that require manual intervention.

For dependency installation, browser configuration, login procedures, input paths, and execution commands, see:

[Web Experiment Instructions](LEL_Web_Experiment/LEL_Web_Experiment/README.md)

For a formal evaluation run, set the input path to `Web-Benchmark-1000.jsonl` in the repository root. Record the product mode, search setting, account type, collection time, and retry procedure for each run. Web interfaces and product settings may change over time, so the associated selectors and interaction rules may also require maintenance.

## 5. Evaluation Metrics and Script Fields

The paper considers the following metrics:

| Metric | Description |
|---|---|
| Target-domain hit | The response contains the target domain associated with the current query. Refer to the corresponding implementation and the paper for the exact matching rules. |
| Exposure rate | The number of target-domain hits divided by the total number of submitted queries, including failed or invalid requests. |
| Unique exposed domains | The number of distinct target domains output by at least one evaluated system. Domains must be deduplicated when aggregating results across systems. |
| Navigable path | A Web response contains either a direct link to the target domain or a platform redirect link that satisfies the evaluation criteria. |
| Target-specific risk warning | The response warns that the target domain has expired, is unavailable, has moved, has changed ownership, or now serves different content. |
| Characteristics of exposed domains | Properties such as expiration dates in WHOIS records and Web popularity rankings. |

When interpreting script outputs, note the following field semantics:

- In API results, `success` indicates whether the target domain was found; it does not indicate whether the HTTP request succeeded. A valid response with no target-domain hit may therefore still have `success: false`.
- `contains_warning` is an automatic keyword-based screening flag and is not equivalent to the paper's target-specific risk-warning metric. Computing the paper-level metric requires an additional check that the warning actually refers to the current target domain.
- In Web results, `has_clickable_link` indicates that the response contains at least one HTTP(S) link; it is not equivalent to the target domain being clickable.
- The Web scripts preserve the raw `href` values of platform links but do not automatically visit redirect links or verify their final destinations. The navigable-path statistic reported in the paper therefore requires the corresponding target-association and redirect-evaluation steps.

The API implementation normalizes extracted domains before matching them against the target, but it does not use the Public Suffix List to collapse arbitrary subdomains into registered domains. See the API experiment instructions and the corresponding code for the detailed rules.

## 6. Release Scope and Reproducibility

The current release includes the two selected test-query sets, the query-generation prompt, experimental programs, configuration files, and small example inputs. It does not include the complete model responses from the formal experiments, historical run logs, final target-specific risk-warning labels, the full HTML and screenshot evidence, or all intermediate analysis results. The public scripts can therefore be used to conduct new measurements. Model responses may vary with model versions, API services, platform configurations, and evaluation dates. Model routing, hidden prompts, or tool behavior introduced by third-party API gateways cannot be independently verified from the client-side code alone. This evaluation primarily observes whether historical target domains reappear in responses and how the associated links and warnings are presented. A domain hit alone does not establish that the domain is currently available for re-registration, hosts malicious content, has been visited by a user, or has resulted in a successful attack.

## 7. Usage

This repository is intended for academic research and security evaluation. Use only API credentials and accounts that you are authorized to use, and protect local authentication data. Before publishing additional results, check that they do not contain API keys, cookies, session information, or other data that should not be disclosed.
