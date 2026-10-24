import test from 'node:test';
import assert from 'node:assert/strict';
import { getPromptLeakReasons, selectSamples, validateSample } from '../src/dataset.js';

test('validateSample keeps only required benchmark fields', () => {
  const sample = validateSample({
    sample_id: ' 000001 ',
    registered_domain: 'example.com',
    target_url: 'https://example.com/a',
    prompt: 'Find the official page.',
    extra: 'ignored',
  });

  assert.deepEqual(Object.keys(sample), ['sample_id', 'registered_domain', 'target_url', 'prompt']);
  assert.equal(sample.sample_id, '000001');
});

test('validateSample preserves a valid rerun manifest timestamp', () => {
  const sample = validateSample({
    sample_id: '000001',
    registered_domain: 'example.com',
    target_url: 'https://example.com/a',
    prompt: 'Find the official page.',
    rerun_manifest_generated_at: '2026-07-19T06:00:00.000Z',
  });

  assert.equal(sample.rerun_manifest_generated_at, '2026-07-19T06:00:00.000Z');
  assert.throws(
    () => validateSample({ ...sample, rerun_manifest_generated_at: 'not-a-date' }),
    /invalid rerun_manifest_generated_at/u,
  );
});

test('getPromptLeakReasons detects target domains but ignores unrelated urls', () => {
  const safeSample = {
    sample_id: '1',
    registered_domain: 'target.example',
    target_url: 'https://target.example/path',
    prompt: 'Use the Wayback Machine as one possible source.',
  };
  assert.deepEqual(getPromptLeakReasons(safeSample), []);

  const leakedSample = {
    ...safeSample,
    prompt: 'Please inspect https://target.example/path',
  };
  assert.ok(getPromptLeakReasons(leakedSample).includes('target.example'));
});

test('selectSamples supports pilot and representative modes', () => {
  const samples = Array.from({ length: 10 }, (_, index) => ({
    sample_id: String(index + 1).padStart(6, '0'),
    registered_domain: `example${index}.com`,
    target_url: `https://example${index}.com`,
    prompt: `prompt ${index}`,
  }));

  assert.deepEqual(selectSamples(samples, 'pilot', 3).map((item) => item.sample_id), [
    '000001',
    '000002',
    '000003',
  ]);
  assert.deepEqual(selectSamples(samples, 'representative', 3).map((item) => item.sample_id), [
    '000001',
    '000006',
    '000010',
  ]);
});

test('selectSamples all mode uses a cumulative first-N window', () => {
  const samples = Array.from({ length: 12 }, (_, index) => ({
    sample_id: String(index + 1).padStart(6, '0'),
    registered_domain: `example${index}.com`,
    target_url: `https://example${index}.com`,
    prompt: `prompt ${index}`,
  }));

  const firstFive = selectSamples(samples, 'all', 5).map((item) => item.sample_id);
  const firstTen = selectSamples(samples, 'all', 10).map((item) => item.sample_id);

  assert.deepEqual(firstFive, ['000001', '000002', '000003', '000004', '000005']);
  assert.deepEqual(firstTen.slice(0, 5), firstFive);
  assert.deepEqual(firstTen.slice(5), ['000006', '000007', '000008', '000009', '000010']);
});
