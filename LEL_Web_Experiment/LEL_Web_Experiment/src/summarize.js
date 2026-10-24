#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { loadJsonlSamples } from './dataset.js';
import {
  isAutomationError,
  isExcludedEvaluationOutcome,
  isInputLeak,
  isModelRefusal,
  latestResultBySample,
  loadExistingResults,
  resolveRunName,
} from './results.js';
import { normalizeBareTextDomain, normalizeDomain } from './domain.js';

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = row[key] ?? null;
    const label = value === null ? 'null' : String(value);
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

function toPercent(numerator, denominator) {
  if (!denominator) {
    return 0;
  }
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function failureReason(row) {
  if (isModelRefusal(row)) {
    return 'model_refusal';
  }
  if (isInputLeak(row)) {
    return 'input_leak';
  }
  if (row.success) {
    return 'success';
  }
  if (row.error_type) {
    return row.error_type;
  }
  return 'target_domain_not_recovered';
}

function csvEscape(value) {
  const text = Array.isArray(value) ? value.join('; ') : String(value ?? '');
  if (/[",\r\n]/u.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function toCsv(rows, columns) {
  const header = columns.map((column) => csvEscape(column.label)).join(',');
  const body = rows.map((row) => columns.map((column) => csvEscape(row[column.key])).join(','));
  return `${[header, ...body].join('\n')}\n`;
}

function renderMarkdown(summary) {
  const lines = [
    `# ${summary.run_name} Summary`,
    '',
    `- Result file: \`${summary.result_file}\``,
    `- Generated at: ${summary.generated_at}`,
    `- Total rows: ${summary.total_rows}`,
    `- Result file rows before dataset filtering: ${summary.result_file_total_rows}`,
    `- Unique samples: ${summary.unique_samples}`,
    `- Evaluated samples: ${summary.evaluated_samples}`,
    `- Excluded normal outcomes: ${summary.excluded_samples}`,
    `- Model refusals (excluded): ${summary.model_refusal_count}`,
    `- Input leaks (excluded): ${summary.input_leak_count}`,
    `- Success: ${summary.success_count} (${summary.success_rate_percent}%)`,
    `- Failed: ${summary.failed_count}`,
    `- Target-domain misses without automation error: ${summary.target_miss_count}`,
    `- With clickable link: ${summary.clickable_link_count}`,
    `- Successful answers with warning: ${summary.warning_count}`,
    `- Target-domain misses with warning: ${summary.target_miss_warning_count}`,
    `- With automation error: ${summary.error_count}`,
    '',
    '## Failure Reasons',
    '',
  ];

  for (const [reason, count] of Object.entries(summary.failure_reason_counts)) {
    lines.push(`- ${reason}: ${count}`);
  }

  lines.push('', '## Error Counts', '');
  for (const [errorType, count] of Object.entries(summary.error_type_counts)) {
    lines.push(`- ${errorType}: ${count}`);
  }

  lines.push('', '## Excluded Normal Outcomes', '');
  for (const [outcome, count] of Object.entries(summary.normal_outcome_counts)) {
    lines.push(`- ${outcome}: ${count}`);
  }

  lines.push('', '## Per Sample', '');
  lines.push('| sample_id | target_domain | success | failure_reason | warning | clickable_link | recovered_domains |');
  lines.push('|---|---|---:|---|---:|---:|---|');
  for (const row of summary.samples) {
    lines.push(
      `| ${row.sample_id} | ${row.target_domain ?? ''} | ${row.success} | ${row.failure_reason} | ${row.contains_warning} | ${row.has_clickable_link} | ${(row.recovered_domains ?? []).join(', ')} |`,
    );
  }

  return `${lines.join('\n')}\n`;
}

async function loadSampleMap(input, inputRequired) {
  const samples = new Map();
  try {
    for (const sample of await loadJsonlSamples(input)) {
      samples.set(sample.sample_id, sample);
    }
  } catch (error) {
    if (inputRequired) {
      throw error;
    }
  }
  return samples;
}

async function buildSummary({ runName, resultDir, input, inputRequired }) {
  const resultFile = path.resolve(resultDir, runName, `${runName}.jsonl`);
  const rows = await loadExistingResults(resultFile);
  const samples = await loadSampleMap(input, inputRequired);
  const allLatestRows = [...latestResultBySample(rows).values()];
  const latestRows = samples.size > 0
    ? allLatestRows.filter((row) => samples.has(row.sample_id))
    : allLatestRows;

  const perSample = latestRows
    .sort((a, b) => String(a.sample_id).localeCompare(String(b.sample_id)))
    .map((row) => {
      const sample = samples.get(row.sample_id);
      const recoveredDomains = [
        ...new Set((row.recovered_domains ?? []).map((domain) => normalizeBareTextDomain(domain)).filter(Boolean)),
      ].sort();
      const normalizedRow = {
        sample_id: row.sample_id,
        target_domain: sample ? normalizeDomain(sample.registered_domain) || normalizeDomain(sample.target_url) : null,
        success: Boolean(row.success),
        contains_warning: Boolean(row.contains_warning),
        has_clickable_link: Boolean(row.has_clickable_link),
        error_type: row.error_type,
        recovered_domains: recoveredDomains,
        response_chars: row.raw_response_text?.length ?? 0,
      };
      return {
        ...normalizedRow,
        included_in_evaluation: !isExcludedEvaluationOutcome(normalizedRow),
        failure_reason: failureReason(normalizedRow),
      };
    });

  const evaluatedRows = perSample.filter((row) => row.included_in_evaluation);
  const successCount = evaluatedRows.filter((row) => row.success).length;
  const errorRows = evaluatedRows.filter((row) => isAutomationError(row));
  const modelRefusalRows = perSample.filter((row) => isModelRefusal(row));
  const inputLeakRows = perSample.filter((row) => isInputLeak(row));
  const targetMissCount = evaluatedRows.filter((row) => row.failure_reason === 'target_domain_not_recovered').length;
  const hitWarningCount = evaluatedRows.filter((row) => row.success && row.contains_warning).length;
  const targetMissWarningCount = evaluatedRows.filter(
    (row) => row.failure_reason === 'target_domain_not_recovered' && row.contains_warning,
  ).length;
  const summary = {
    run_name: runName,
    result_file: path.relative(process.cwd(), resultFile).replaceAll(path.sep, '/'),
    generated_at: new Date().toISOString(),
    total_rows: latestRows.length,
    result_file_total_rows: rows.length,
    unique_samples: perSample.length,
    evaluated_samples: evaluatedRows.length,
    excluded_samples: perSample.length - evaluatedRows.length,
    model_refusal_count: modelRefusalRows.length,
    input_leak_count: inputLeakRows.length,
    success_count: successCount,
    failed_count: evaluatedRows.length - successCount,
    target_miss_count: targetMissCount,
    success_rate_percent: toPercent(successCount, evaluatedRows.length),
    clickable_link_count: perSample.filter((row) => row.has_clickable_link).length,
    warning_count: hitWarningCount,
    target_miss_warning_count: targetMissWarningCount,
    error_count: errorRows.length,
    error_type_counts: countBy(errorRows, 'error_type'),
    normal_outcome_counts: {
      model_refusal: modelRefusalRows.length,
      input_leak: inputLeakRows.length,
    },
    failure_reason_counts: countBy(evaluatedRows.filter((row) => !row.success), 'failure_reason'),
    samples: perSample,
  };

  return summary;
}

async function writePerRunSummary(summary, resultDir) {
  const runDir = path.resolve(resultDir, summary.run_name);
  await fs.mkdir(runDir, { recursive: true });
  const summaryJsonPath = path.join(runDir, 'summary.json');
  const summaryMdPath = path.join(runDir, 'summary.md');
  await fs.writeFile(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await fs.writeFile(summaryMdPath, renderMarkdown(summary), 'utf8');
  return { summaryJsonPath, summaryMdPath };
}

async function listRunNames(resultDir) {
  let entries = [];
  try {
    entries = await fs.readdir(resultDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(resultDir, entry.name, `${entry.name}.jsonl`);
    try {
      await fs.access(candidate);
      names.push(entry.name);
    } catch {
      // Not a run directory.
    }
  }
  return names.sort();
}

async function writeAllRunsCsv(summaries, resultDir) {
  await fs.mkdir(resultDir, { recursive: true });
  const summaryRows = summaries.map((summary) => ({
    run_name: summary.run_name,
    unique_samples: summary.unique_samples,
    evaluated_samples: summary.evaluated_samples,
    excluded_samples: summary.excluded_samples,
    model_refusal_count: summary.model_refusal_count,
    input_leak_count: summary.input_leak_count,
    success_count: summary.success_count,
    failed_count: summary.failed_count,
    target_miss_count: summary.target_miss_count,
    error_count: summary.error_count,
    success_rate_percent: summary.success_rate_percent,
    warning_count: summary.warning_count,
    target_miss_warning_count: summary.target_miss_warning_count,
    clickable_link_count: summary.clickable_link_count,
    failure_reason_counts: JSON.stringify(summary.failure_reason_counts),
    error_type_counts: JSON.stringify(summary.error_type_counts),
    normal_outcome_counts: JSON.stringify(summary.normal_outcome_counts),
  }));
  const sampleRows = summaries.flatMap((summary) =>
    summary.samples.map((sample) => ({
      run_name: summary.run_name,
      sample_id: sample.sample_id,
      target_domain: sample.target_domain,
      success: sample.success,
      failure_reason: sample.failure_reason,
      error_type: sample.error_type,
      included_in_evaluation: sample.included_in_evaluation,
      contains_warning: sample.contains_warning,
      has_clickable_link: sample.has_clickable_link,
      recovered_domains: sample.recovered_domains,
      response_chars: sample.response_chars,
    })),
  );

  const summaryPath = path.join(resultDir, 'all-runs-summary.csv');
  const samplesPath = path.join(resultDir, 'all-runs-samples.csv');
  await fs.writeFile(
    summaryPath,
    toCsv(summaryRows, [
      { key: 'run_name', label: 'run_name' },
      { key: 'unique_samples', label: 'unique_samples' },
      { key: 'evaluated_samples', label: 'evaluated_samples' },
      { key: 'excluded_samples', label: 'excluded_samples' },
      { key: 'model_refusal_count', label: 'model_refusal_count' },
      { key: 'input_leak_count', label: 'input_leak_count' },
      { key: 'success_count', label: 'success_count' },
      { key: 'failed_count', label: 'failed_count' },
      { key: 'target_miss_count', label: 'target_miss_count' },
      { key: 'error_count', label: 'error_count' },
      { key: 'success_rate_percent', label: 'success_rate_percent' },
      { key: 'warning_count', label: 'warning_count' },
      { key: 'target_miss_warning_count', label: 'target_miss_warning_count' },
      { key: 'clickable_link_count', label: 'clickable_link_count' },
      { key: 'failure_reason_counts', label: 'failure_reason_counts' },
      { key: 'error_type_counts', label: 'error_type_counts' },
      { key: 'normal_outcome_counts', label: 'normal_outcome_counts' },
    ]),
    'utf8',
  );
  await fs.writeFile(
    samplesPath,
    toCsv(sampleRows, [
      { key: 'run_name', label: 'run_name' },
      { key: 'sample_id', label: 'sample_id' },
      { key: 'target_domain', label: 'target_domain' },
      { key: 'success', label: 'success' },
      { key: 'failure_reason', label: 'failure_reason' },
      { key: 'error_type', label: 'error_type' },
      { key: 'included_in_evaluation', label: 'included_in_evaluation' },
      { key: 'contains_warning', label: 'contains_warning' },
      { key: 'has_clickable_link', label: 'has_clickable_link' },
      { key: 'recovered_domains', label: 'recovered_domains' },
      { key: 'response_chars', label: 'response_chars' },
    ]),
    'utf8',
  );
  return { summaryPath, samplesPath };
}

async function summarizeOne(options) {
  const runName = resolveRunName({
    runName: options.runName,
    runId: options.runId,
    defaultRunName: options.platform,
  });
  const summary = await buildSummary({
    runName,
    resultDir: options.resultDir,
    input: options.input,
    inputRequired: options.inputRequired,
  });
  const paths = await writePerRunSummary(summary, options.resultDir);

  console.log(`summary_json: ${paths.summaryJsonPath}`);
  console.log(`summary_md: ${paths.summaryMdPath}`);
  console.log(`success: ${summary.success_count}/${summary.evaluated_samples} (${summary.success_rate_percent}%)`);
  console.log(
    `failed: ${summary.failed_count}; errors: ${summary.error_count}; target_miss: ${summary.target_miss_count}; refusals_excluded: ${summary.model_refusal_count}`,
  );
}

async function summarizeAll(options) {
  const runNames = await listRunNames(options.resultDir);
  const summaries = [];
  for (const runName of runNames) {
    const summary = await buildSummary({
      runName,
      resultDir: options.resultDir,
      input: options.input,
      inputRequired: options.inputRequired,
    });
    await writePerRunSummary(summary, options.resultDir);
    summaries.push(summary);
  }
  const paths = await writeAllRunsCsv(summaries, options.resultDir);
  console.log(`all_runs_summary_csv: ${paths.summaryPath}`);
  console.log(`all_runs_samples_csv: ${paths.samplesPath}`);
  console.log(`runs: ${summaries.length}`);
}

const program = new Command();
program
  .name('web-prompt summarize')
  .option('--run-name <name>', 'Run name, for example deepseek-fast')
  .option('--run-id <id>', 'Deprecated alias for --run-name')
  .option('--all', 'Summarize every run under result-dir and write root CSV files', false)
  .option('--result-dir <dir>', 'Result output directory', process.env.LEL_RESULT_DIR ?? 'result')
  .option('--input <file>', 'Benchmark JSONL file for target-domain lookup', 'examples/sample.jsonl')
  .option('--input-required', 'Fail if input JSONL cannot be loaded', false)
  .action((options) => {
    if (options.all) {
      return summarizeAll(options);
    }
    if (!options.runName && !options.runId) {
      throw new Error('Provide --run-name, or pass --all to summarize every run');
    }
    return summarizeOne(options);
  });

program.parseAsync().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
