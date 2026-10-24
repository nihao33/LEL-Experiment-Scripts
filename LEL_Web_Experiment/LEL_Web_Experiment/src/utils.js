import path from 'node:path';

export function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }

  return parsed;
}

export function parseNonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got: ${value}`);
  }

  return parsed;
}

export function parseRate(value, fallback = 0) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Expected a rate between 0 and 1, got: ${value}`);
  }

  return parsed;
}

export function parseCsvSet(value) {
  if (!value) {
    return new Set();
  }

  return new Set(
    String(value)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function normalizePathForJson(filePath) {
  return filePath.split(path.sep).join('/');
}

export function safeFilePart(value) {
  return String(value)
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'item';
}

export function hashToUnitInterval(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) / 0xffffffff;
}

export function makeRunId(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}
