import fs from 'node:fs/promises';
import { normalizeDomain } from './domain.js';

const REQUIRED_FIELDS = ['sample_id', 'registered_domain', 'target_url', 'prompt'];

export function validateSample(sample, lineNumber = 0) {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) {
    throw new Error(`Line ${lineNumber}: expected a JSON object`);
  }

  for (const field of REQUIRED_FIELDS) {
    if (typeof sample[field] !== 'string' || !sample[field].trim()) {
      throw new Error(`Line ${lineNumber}: missing required string field "${field}"`);
    }
  }

  const validated = {
    sample_id: sample.sample_id.trim(),
    registered_domain: sample.registered_domain.trim(),
    target_url: sample.target_url.trim(),
    prompt: sample.prompt,
  };

  if (sample.rerun_manifest_generated_at !== undefined) {
    if (
      typeof sample.rerun_manifest_generated_at !== 'string' ||
      !Number.isFinite(Date.parse(sample.rerun_manifest_generated_at))
    ) {
      throw new Error(`Line ${lineNumber}: invalid rerun_manifest_generated_at timestamp`);
    }
    validated.rerun_manifest_generated_at = sample.rerun_manifest_generated_at;
  }

  return validated;
}

export async function loadJsonlSamples(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  const lines = content.split(/\r?\n/u).filter((line) => line.trim());

  return lines.map((line, index) => {
    try {
      return validateSample(JSON.parse(line), index + 1);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Line ${index + 1}: invalid JSON: ${error.message}`);
      }
      throw error;
    }
  });
}

export function getPromptLeakReasons(sample) {
  const prompt = String(sample.prompt || '').toLowerCase();
  const candidates = new Set();

  for (const value of [sample.registered_domain, sample.target_url]) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw && raw.includes('.')) {
      candidates.add(raw.replace(/^https?:\/\//iu, '').split(/[/?#]/u)[0].replace(/^www\./u, ''));
    }

    const normalized = normalizeDomain(value);
    if (normalized) {
      candidates.add(normalized);
      candidates.add(`www.${normalized}`);
    }
  }

  if (sample.target_url && /^https?:\/\//iu.test(sample.target_url)) {
    candidates.add(sample.target_url.toLowerCase());
  }

  return [...candidates].filter((candidate) => prompt.includes(candidate.toLowerCase()));
}

export function selectSamples(samples, mode = 'representative', limit = samples.length) {
  const effectiveLimit = Math.min(limit, samples.length);
  if (effectiveLimit <= 0) {
    return [];
  }

  if (mode === 'pilot' || mode === 'all') {
    return samples.slice(0, effectiveLimit);
  }

  if (mode !== 'representative') {
    throw new Error(`Unknown sample mode: ${mode}`);
  }

  if (effectiveLimit === 1) {
    return [samples[0]];
  }

  const indexes = new Set();
  for (let i = 0; i < effectiveLimit; i += 1) {
    indexes.add(Math.round((i * (samples.length - 1)) / (effectiveLimit - 1)));
  }

  let cursor = 0;
  while (indexes.size < effectiveLimit && cursor < samples.length) {
    indexes.add(cursor);
    cursor += 1;
  }

  return [...indexes]
    .sort((a, b) => a - b)
    .slice(0, effectiveLimit)
    .map((index) => samples[index]);
}
