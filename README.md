# LLM Expired Links (LEL): Benchmark and Experiment Scripts

This repository contains the benchmark datasets and experiment scripts for our study of **LLM Expired Links (LEL)**, a security risk in which large language models (LLMs) reproduce expired domains associated with legitimate entities, potentially directing users to outdated or untrusted Web resources.

The repository supports research on expired-domain exposure in LLM-generated responses, including the presentation of links and the presence of target-related risk warnings.

## Repository Contents

| File                       | Description                                                  |
| -------------------------- | ------------------------------------------------------------ |
| `API-Benchmark-3000.jsonl` | Benchmark dataset containing 3,000 natural-language test queries for API-based LLM experiments. |
| `Web-Benchmark-1000.jsonl` | Benchmark dataset containing 1,000 natural-language test queries for Web-based AI product experiments. |
| `LEL_API_Experiment`   | Source code for conducting API-based experiments and processing their outputs. |
| `LEL_Web_Experiment`   | Source code for conducting Web-based experiments and collecting experimental outputs. |

The experiment scripts are provided separately for API-based LLMs and Web-based AI products because the two settings use different interaction methods and output formats.

## Dataset Description

The benchmark datasets were constructed from historical external links collected from English and Chinese Wikipedia. DNS and WHOIS information was used to identify expired domains, and GPT-5 was used to generate natural-language queries based on historical page information and contextual evidence.

The generated queries do not explicitly provide the corresponding target domain or URL. This design allows us to investigate whether an LLM outputs the associated expired domain in response to a natural-language information request.

Each JSONL file contains one JSON object per line, with each record representing a test case associated with a target domain.

Please preserve the original sample identifiers and record contents when reproducing the experiments. The API and Web datasets are separate benchmark subsets and should not be treated as identical query sets.

## Experimental Scripts

### API-Based Experiments

`LEL_API_Experiment.zip` contains the scripts for submitting benchmark queries to API-based LLMs, collecting model responses, and processing experimental results.

Users must provide their own valid API credentials and configure the required model and endpoint settings before running experiments.

### Web-Based Experiments

`LEL_Web_Experiment.zip` contains the scripts for conducting browser-based experiments on Web-based AI products and collecting their responses.

Depending on the platform and configuration, users may need to complete authentication manually and configure the required browser environment.

For installation instructions, dependencies, configuration options, and execution commands, please consult the README and documentation included in each experiment package.

## Evaluation Metrics

The study examines the following aspects of LEL:

- **Domain exposure:** whether a model response contains the target expired domain.
- **Exposure rate:** the number of target-domain hits divided by the total number of submitted queries, including failed or invalid requests.
- **Unique domains:** the number of distinct target domains exposed by at least one evaluated system.
- **Navigable links:** whether a Web-based hit response provides a navigable path to the target domain.
- **Risk warnings:** whether a response contains a warning relevant to the target domain's expiration, availability, ownership, or content status.
- **Exposed-domain characteristics:** including WHOIS-record expiration dates and Web popularity rankings.

API responses and Web-based responses have different output structures. In particular, API-generated URLs and Markdown hyperlinks are text outputs, whereas Web-based products may provide directly navigable links. Navigable-link statistics should therefore be interpreted according to the measurement criteria defined in the paper.

## Reproducibility and Limitations

The released datasets represent the selected benchmark queries used in the experiments. They do not cover every expired domain, possible user query, LLM, or Web-based AI product.

LLM responses may vary across model versions, API configurations, platform updates, and execution times. Re-running the experiments may therefore produce results different from those reported in the paper.

The benchmark measures target-domain exposure and related response characteristics. It does not, by itself, establish that an exposed domain is malicious, that a user clicked a link, or that an attack succeeded.

The scripts are provided to support research transparency and further investigation. Please consult the paper and the documentation in each experiment package for the precise experimental setup and measurement criteria.

## Responsible Use

This repository is intended for academic research and security evaluation.

- Use only API credentials and accounts that you are authorized to access.
- Do not publish API keys, authentication cookies, session files, or other secrets.
- Treat expired-domain URLs as potentially untrusted resources. Do not visit or interact with them without appropriate security precautions.
- Do not use the benchmark to facilitate phishing, fraud, unauthorized access, or other malicious activities.


