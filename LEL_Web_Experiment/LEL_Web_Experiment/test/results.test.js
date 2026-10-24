import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendResult,
  ensureRunFile,
  filterOverwriteManifestForResume,
  filterSamplesForResume,
  isAutomationError,
  isExcludedEvaluationOutcome,
  resolveRunName,
} from '../src/results.js';

test('filterSamplesForResume skips existing rows by sample_id', () => {
  const samples = [
    { sample_id: '1' },
    { sample_id: '2' },
    { sample_id: '3' },
  ];
  const existingRows = [
    { sample_id: '1', success: true },
    { sample_id: '2', success: false },
  ];

  assert.deepEqual(filterSamplesForResume(samples, existingRows).map((item) => item.sample_id), ['3']);
  assert.deepEqual(
    filterSamplesForResume(samples, existingRows, { retryFailed: true }).map((item) => item.sample_id),
    ['2', '3'],
  );
  assert.deepEqual(
    filterSamplesForResume(samples, [{ sample_id: '1', error_type: 'answer_timeout' }, { sample_id: '2', success: false }], {
      retryErrors: true,
    }).map((item) => item.sample_id),
    ['1', '3'],
  );

  const normalOutcomes = [
    { sample_id: '1', success: false, error_type: 'model_refusal' },
    { sample_id: '2', success: false, error_type: 'input_leak' },
  ];
  assert.deepEqual(filterSamplesForResume(samples, normalOutcomes, { retryErrors: true }).map((item) => item.sample_id), ['3']);
  assert.deepEqual(filterSamplesForResume(samples, normalOutcomes, { retryFailed: true }).map((item) => item.sample_id), ['3']);
});

test('model refusals and input leaks are excluded outcomes, not automation errors', () => {
  assert.equal(isExcludedEvaluationOutcome({ error_type: 'model_refusal' }), true);
  assert.equal(isExcludedEvaluationOutcome({ error_type: 'input_leak' }), true);
  assert.equal(isAutomationError({ error_type: 'model_refusal' }), false);
  assert.equal(isAutomationError({ error_type: 'input_leak' }), false);
  assert.equal(isAutomationError({ error_type: 'page_structure_changed' }), true);
});

test('filterOverwriteManifestForResume skips samples replaced after the manifest was generated', () => {
  const generatedAt = '2026-07-19T06:00:00.000Z';
  const samples = [
    { sample_id: '1', rerun_manifest_generated_at: generatedAt },
    { sample_id: '2', rerun_manifest_generated_at: generatedAt },
    { sample_id: '3', rerun_manifest_generated_at: generatedAt },
    { sample_id: '4' },
  ];
  const existingRows = [
    { sample_id: '1', timestamp: '2026-07-19T06:01:00.000Z' },
    { sample_id: '2', timestamp: '2026-07-19T05:59:00.000Z' },
    { sample_id: '4', timestamp: '2026-07-19T06:02:00.000Z' },
  ];

  assert.deepEqual(
    filterOverwriteManifestForResume(samples, existingRows).map((item) => item.sample_id),
    ['2', '3', '4'],
  );
});

test('resolveRunName and ensureRunFile use run-name folder layout', async () => {
  const runName = resolveRunName({ defaultRunName: 'deepseek-thinking-search' });
  assert.equal(runName, 'deepseek-thinking-search');

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-prompt-result-'));
  const resultFile = await ensureRunFile(tempDir, runName);
  assert.match(resultFile.replaceAll('\\', '/'), /deepseek-thinking-search\/deepseek-thinking-search\.jsonl$/u);
});

test('appendResult writes aggregate JSONL and per-sample pretty raw JSON', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-prompt-result-'));
  const resultFile = await ensureRunFile(tempDir, 'qwen');
  const row = {
    sample_id: '000008',
    platform: 'qwen',
    success: false,
    final_state: 'completed',
    state_trace: [{ state: 'searching' }, { state: 'completed' }],
  };

  await appendResult(resultFile, row);

  const aggregate = JSON.parse((await fs.readFile(resultFile, 'utf8')).trim());
  assert.equal(aggregate.sample_id, '000008');
  assert.equal(aggregate.final_state, 'completed');
  assert.equal(aggregate.state_trace, undefined);
  const raw = await fs.readFile(path.join(tempDir, 'qwen', 'raw', '000008.json'), 'utf8');
  assert.match(raw, /\n  "sample_id": "000008"/u);
  assert.deepEqual(JSON.parse(raw), row);
});

test('appendResult can replace existing aggregate and raw rows for a rerun sample', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-prompt-result-'));
  const resultFile = await ensureRunFile(tempDir, 'qwen');

  await appendResult(resultFile, {
    sample_id: '000067',
    platform: 'qwen',
    success: false,
    raw_response_text: 'old answer',
    state_trace: [{ state: 'old' }],
  });
  await appendResult(resultFile, {
    sample_id: '000068',
    platform: 'qwen',
    success: true,
    raw_response_text: 'other answer',
  });
  await appendResult(
    resultFile,
    {
      sample_id: '000067',
      platform: 'qwen',
      success: true,
      raw_response_text: 'new answer',
      state_trace: [{ state: 'new' }],
    },
    { replaceExisting: true },
  );

  const aggregateRows = (await fs.readFile(resultFile, 'utf8'))
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    aggregateRows.map((row) => [row.sample_id, row.success, row.raw_response_text]),
    [
      ['000068', true, 'other answer'],
      ['000067', true, 'new answer'],
    ],
  );
  assert.equal(aggregateRows[1].state_trace, undefined);

  const raw = JSON.parse(await fs.readFile(path.join(tempDir, 'qwen', 'raw', '000067.json'), 'utf8'));
  assert.equal(raw.raw_response_text, 'new answer');
  assert.deepEqual(raw.state_trace, [{ state: 'new' }]);
});
