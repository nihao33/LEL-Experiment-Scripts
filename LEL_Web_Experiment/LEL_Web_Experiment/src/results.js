import fs from 'node:fs/promises';
import path from 'node:path';
import { safeFilePart } from './utils.js';

export function resolveRunName({ runName, runId, defaultRunName }) {
  return safeFilePart(runName || runId || defaultRunName || 'run');
}

export async function ensureRunFile(resultDir, runName) {
  const safeRunName = safeFilePart(runName);
  const runDir = path.resolve(resultDir, safeRunName);
  await fs.mkdir(runDir, { recursive: true });
  return path.join(runDir, `${safeRunName}.jsonl`);
}

export async function appendResult(resultFile, result, { replaceExisting = false } = {}) {
  await fs.mkdir(path.dirname(resultFile), { recursive: true });
  const aggregateResult = { ...result };
  delete aggregateResult.state_trace;
  const line = `${JSON.stringify(aggregateResult)}\n`;

  if (replaceExisting) {
    const existingRows = await loadExistingResults(resultFile);
    const nextRows = existingRows.filter((row) => row?.sample_id !== result.sample_id);
    const nextContent = `${nextRows.map((row) => JSON.stringify(row)).join('\n')}${
      nextRows.length > 0 ? '\n' : ''
    }${line}`;
    const tempFile = `${resultFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempFile, nextContent, 'utf8');
    await fs.rename(tempFile, resultFile);
  } else {
    await fs.appendFile(resultFile, line, 'utf8');
  }

  const rawDir = path.join(path.dirname(resultFile), 'raw');
  await fs.mkdir(rawDir, { recursive: true });
  await fs.writeFile(path.join(rawDir, `${safeFilePart(result.sample_id)}.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

export async function loadExistingResults(resultFile) {
  let content = '';
  try {
    content = await fs.readFile(resultFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return content
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid existing result at ${resultFile}:${index + 1}: ${error.message}`);
      }
    });
}

export function latestResultBySample(existingRows) {
  const latestBySample = new Map();
  for (const row of existingRows) {
    if (row?.sample_id) {
      latestBySample.set(row.sample_id, row);
    }
  }
  return latestBySample;
}

export function isModelRefusal(row) {
  return row?.error_type === 'model_refusal' || row?.final_state === 'refusal';
}

export function isInputLeak(row) {
  return row?.error_type === 'input_leak';
}

export function isExcludedEvaluationOutcome(row) {
  return isModelRefusal(row) || isInputLeak(row);
}

export function isAutomationError(row) {
  return Boolean(row?.error_type) && !isExcludedEvaluationOutcome(row);
}

export function filterSamplesForResume(samples, existingRows, { retryFailed = false, retryErrors = false } = {}) {
  const latestBySample = latestResultBySample(existingRows);

  if (retryErrors) {
    return samples.filter((sample) => {
      const existing = latestBySample.get(sample.sample_id);
      return !existing || isAutomationError(existing);
    });
  }

  if (retryFailed) {
    return samples.filter((sample) => {
      const existing = latestBySample.get(sample.sample_id);
      return !existing || (!isExcludedEvaluationOutcome(existing) && existing.success !== true);
    });
  }

  return samples.filter((sample) => !latestBySample.has(sample.sample_id));
}

export function filterOverwriteManifestForResume(samples, existingRows) {
  const latestBySample = latestResultBySample(existingRows);

  return samples.filter((sample) => {
    const manifestTimestamp = Date.parse(sample.rerun_manifest_generated_at ?? '');
    if (!Number.isFinite(manifestTimestamp)) {
      return true;
    }

    const existing = latestBySample.get(sample.sample_id);
    if (!existing) {
      return true;
    }

    const existingTimestamp = Date.parse(existing.timestamp ?? '');
    if (!Number.isFinite(existingTimestamp)) {
      return true;
    }

    return existingTimestamp <= manifestTimestamp;
  });
}
