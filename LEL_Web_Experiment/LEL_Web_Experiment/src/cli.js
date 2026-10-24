#!/usr/bin/env node
import { Command } from 'commander';
import { loadPlatformConfig, listAvailablePlatforms } from './config.js';
import { loadJsonlSamples, selectSamples } from './dataset.js';
import {
  ensureRunFile,
  filterOverwriteManifestForResume,
  filterSamplesForResume,
  loadExistingResults,
  resolveRunName,
} from './results.js';
import { parseCsvSet, parseNonNegativeInteger, parsePositiveInteger, parseRate } from './utils.js';
import { runPlatformBenchmark, runPlatformLogin } from './runner.js';

function addBrowserOptions(command) {
  return command
    .option('--browser-channel <channel>', 'Browser channel, for example chrome or msedge', process.env.LEL_BROWSER_CHANNEL)
    .option('--browser-executable <path>', 'Explicit browser executable path', process.env.LEL_BROWSER_EXECUTABLE)
    .option(
      '--fallback-browser-channel <channel>',
      'Fallback browser channel; pass none to disable',
      process.env.LEL_FALLBACK_BROWSER_CHANNEL,
    )
    .option(
      '--fallback-browser-executable <path>',
      'Fallback browser executable path; pass none to disable. Explicit primary browsers have no automatic fallback.',
      process.env.LEL_FALLBACK_BROWSER_EXECUTABLE,
    )
    .option('--auth-dir <dir>', 'Local persistent browser profile directory; never publish it', process.env.LEL_AUTH_DIR ?? '.auth')
    .option('--headless', 'Run headless; not recommended for first login', false)
    .option('--no-chromium-sandbox', 'Disable Chromium sandbox; not recommended for ChatGPT/Cloudflare pages')
    .option('--non-interactive', 'Do not pause for manual handling; record the error instead', false)
    .option('--skip-login-prompt', 'Do not wait for manual login confirmation', false)
    .option('--slow-mo <ms>', 'Playwright slowMo in milliseconds', '0')
    .option('--timeout <ms>', 'Default page timeout in milliseconds', '20000');
}

function addCommonOptions(command, defaults) {
  let configured = command
      .requiredOption('--platform <name>', 'Platform name: chatgpt, kimi, qwen, deepseek, doubao, gemini')
      .option('--input <file>', 'Input JSONL file', defaults.input ?? 'examples/sample.jsonl')
      .option('--platform-dir <dir>', 'Platform config directory', process.env.LEL_PLATFORM_DIR ?? 'platforms')
      .option('--result-dir <dir>', 'Result output directory', process.env.LEL_RESULT_DIR ?? 'result')
      .option('--evidence-dir <dir>', 'Evidence output directory', process.env.LEL_EVIDENCE_DIR ?? 'evidence')
      .option('--run-name <name>', 'Run folder and JSONL base name')
      .option('--run-id <id>', 'Deprecated alias for --run-name')
      .option('--sample <mode>', 'Sample selection mode: pilot, representative, all', defaults.sample)
      .option('--sample-ids <ids>', 'Comma-separated sample_ids to run exactly')
      .option('--next <n>', 'Run the next N pending samples after existing results are skipped')
      .option('--resume', 'Skip samples already present in the current run-name result file', true)
      .option('--no-resume', 'Do not skip existing samples; append duplicate rows intentionally')
      .option('--overwrite-results', 'Replace existing aggregate/raw/evidence rows for samples that are rerun', false)
      .option('--retry-failed', 'Only rerun missing or unsuccessful samples', false)
      .option('--retry-errors', 'Only rerun missing samples or samples with automation error_type', false)
      .option('--evidence-sample-rate <rate>', 'Evidence sampling rate between 0 and 1', '0')
      .option('--manual-evidence <ids>', 'Comma-separated sample_ids that must save evidence')
      .option('--delay-between-samples-ms <ms>', 'Wait this many milliseconds between samples to reduce request pressure')
      .option('--delay-jitter-ms <ms>', 'Add up to this many random extra milliseconds to the between-sample delay');

  if (defaults.limit === undefined || defaults.limit === null) {
    configured = configured.option('--limit <n>', 'Sample count; omit to run the full selected dataset');
  } else {
    configured = configured.option('--limit <n>', 'Sample count', String(defaults.limit));
  }

  return addBrowserOptions(configured);
}

function buildRuntimeOptions(options) {
  return {
    browserChannel: options.browserChannel,
    browserExecutable: options.browserExecutable,
    fallbackBrowserChannel: options.fallbackBrowserChannel,
    fallbackBrowserExecutable: options.fallbackBrowserExecutable,
    authDir: options.authDir,
    headless: Boolean(options.headless),
    chromiumSandbox: options.chromiumSandbox !== false,
    skipLoginPrompt: Boolean(options.skipLoginPrompt),
    slowMo: Number.parseInt(options.slowMo, 10) || 0,
    defaultTimeoutMs: Number.parseInt(options.timeout, 10) || 20000,
    delayBetweenSamplesMs: parseNonNegativeInteger(options.delayBetweenSamplesMs, null),
    delayJitterMs: parseNonNegativeInteger(options.delayJitterMs, null),
    overwriteResults: Boolean(options.overwriteResults),
    interactive: !options.nonInteractive,
  };
}

async function runCommand(options) {
  const samples = await loadJsonlSamples(options.input);
  const config = await loadPlatformConfig(options.platform, options.platformDir);
  const resultDir = options.resultDir;
  const runName = resolveRunName({
    runName: options.runName,
    runId: options.runId,
    defaultRunName: config.defaultRunName || config.name,
  });
  const resultFile = await ensureRunFile(resultDir, runName);
  const existingRows = await loadExistingResults(resultFile);
  const sampleIds = parseCsvSet(options.sampleIds);
  let selected = [];

  if (sampleIds.size > 0) {
    selected = samples.filter((sample) => sampleIds.has(sample.sample_id));
    const foundIds = new Set(selected.map((sample) => sample.sample_id));
    const missingIds = [...sampleIds].filter((sampleId) => !foundIds.has(sampleId));
    if (missingIds.length > 0) {
      throw new Error(`Unknown sample_id(s): ${missingIds.join(', ')}`);
    }
  } else {
    const limit = options.next === undefined
      ? options.limit === undefined
        ? samples.length
        : parsePositiveInteger(options.limit, samples.length)
      : samples.length;
    selected = selectSamples(samples, options.sample, limit);
  }

  let pendingSamples = [];
  if (options.retryFailed || options.retryErrors) {
    pendingSamples = filterSamplesForResume(selected, existingRows, {
      retryFailed: options.retryFailed,
      retryErrors: options.retryErrors,
    });
  } else if (options.overwriteResults && options.resume) {
    pendingSamples = filterOverwriteManifestForResume(selected, existingRows);
  } else if (options.overwriteResults) {
    pendingSamples = selected;
  } else if (options.next !== undefined || options.resume) {
    pendingSamples = filterSamplesForResume(selected, existingRows);
  } else {
    pendingSamples = selected;
  }

  if (options.next !== undefined) {
    pendingSamples = pendingSamples.slice(0, parsePositiveInteger(options.next, samples.length));
  }

  console.log(`platform: ${config.displayName} (${config.name})`);
  console.log(`run_name: ${runName}`);
  console.log(`result_file: ${resultFile}`);
  console.log(`selected_samples: ${selected.length}; pending_samples: ${pendingSamples.length}`);
  if (options.next !== undefined) {
    console.log(`next_pending_limit: ${options.next}`);
  }
  if (sampleIds.size > 0) {
    console.log(`sample_ids: ${[...sampleIds].join(',')}`);
  }
  if (options.overwriteResults) {
    console.log('overwrite_results: enabled');
    if (options.resume && selected.some((sample) => sample.rerun_manifest_generated_at)) {
      console.log(`overwrite_resume_skipped: ${selected.length - pendingSamples.length}`);
    }
  }

  if (pendingSamples.length === 0) {
    console.log('No pending samples.');
    return;
  }

  await runPlatformBenchmark({
    config,
    samples: pendingSamples,
    resultFile,
    options: {
      ...buildRuntimeOptions(options),
      runName,
      evidenceDir: options.evidenceDir,
      manualEvidenceIds: parseCsvSet(options.manualEvidence),
      evidenceSampleRate: parseRate(options.evidenceSampleRate, 0),
    },
  });
}

async function loginCommand(options) {
  const config = await loadPlatformConfig(options.platform, options.platformDir);
  await runPlatformLogin({
    config,
    options: buildRuntimeOptions(options),
  });
}

const program = new Command();
program.name('web-prompt').description('Semi-automated AI web benchmark collector').showHelpAfterError();

addBrowserOptions(
  program
    .command('login')
    .description('Open a platform login page and persist the browser profile')
    .requiredOption('--platform <name>', 'Platform name')
    .option('--platform-dir <dir>', 'Platform config directory', process.env.LEL_PLATFORM_DIR ?? 'platforms'),
).action(loginCommand);

addCommonOptions(program.command('pilot').description('Run 5 samples for platform selector adaptation'), {
  input: 'examples/sample.jsonl',
  limit: 5,
  sample: 'pilot',
}).action(runCommand);

addCommonOptions(program.command('phase1').description('Run a JSONL benchmark dataset against one web AI platform'), {
  input: 'examples/sample.jsonl',
  limit: undefined,
  sample: 'all',
}).action(runCommand);

addCommonOptions(program.command('collect').description('Run representative collection from the full benchmark'), {
  input: 'examples/sample.jsonl',
  limit: 100,
  sample: 'representative',
}).action(runCommand);

program
  .command('platforms')
  .description('List available platform configs')
  .option('--platform-dir <dir>', 'Platform config directory', process.env.LEL_PLATFORM_DIR ?? 'platforms')
  .action(async (options) => {
    const platforms = await listAvailablePlatforms(options.platformDir);
    console.log(platforms.join('\n'));
  });

program.parseAsync().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
