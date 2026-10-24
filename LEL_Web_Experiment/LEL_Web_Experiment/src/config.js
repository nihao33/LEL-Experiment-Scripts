import fs from 'node:fs/promises';
import path from 'node:path';

const REQUIRED_PLATFORM_FIELDS = [
  'name',
  'displayName',
  'loginUrl',
  'newChat',
  'inputSelector',
  'sendButtonSelector',
  'assistantMessageSelector',
];

export async function loadPlatformConfig(platform, platformDir = 'platforms') {
  const configPath = path.resolve(platformDir, `${platform}.json`);
  const raw = await fs.readFile(configPath, 'utf8');
  const config = JSON.parse(raw);

  for (const field of REQUIRED_PLATFORM_FIELDS) {
    if (config[field] === undefined || config[field] === null || config[field] === '') {
      throw new Error(`Platform config ${configPath} is missing "${field}"`);
    }
  }

  if (config.name !== platform) {
    throw new Error(`Platform config ${configPath} has name "${config.name}", expected "${platform}"`);
  }

  return config;
}

export async function listAvailablePlatforms(platformDir = 'platforms') {
  const entries = await fs.readdir(platformDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.basename(entry.name, '.json'))
    .sort();
}
