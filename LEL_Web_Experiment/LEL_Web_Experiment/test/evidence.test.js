import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { saveEvidence, shouldSaveEvidence } from '../src/evidence.js';

test('shouldSaveEvidence saves hits, misses, errors, manual ids, and sampled rows', () => {
  assert.equal(shouldSaveEvidence({ sample_id: '1', platform: 'chatgpt', success: true }), true);
  assert.equal(shouldSaveEvidence({ sample_id: '2', platform: 'chatgpt', success: false }), true);
  assert.equal(
    shouldSaveEvidence({ sample_id: '3', platform: 'chatgpt', success: false, error_type: 'page_exception' }),
    true,
  );
  assert.equal(
    shouldSaveEvidence(
      { sample_id: '4', platform: 'chatgpt', success: null },
      { manualEvidenceIds: new Set(['4']) },
    ),
    true,
  );
  assert.equal(
    shouldSaveEvidence(
      { sample_id: '5', platform: 'chatgpt', success: null },
      { evidenceSampleRate: 1 },
    ),
    true,
  );
  assert.equal(shouldSaveEvidence({ sample_id: '6', platform: 'chatgpt', success: null }), false);
  assert.equal(
    shouldSaveEvidence({ sample_id: '7', platform: 'chatgpt', success: null }, { overwriteResults: true }),
    true,
  );
});

test('saveEvidence can replace an existing sample evidence directory', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({
      channel: process.env.WEB_PROMPT_TEST_BROWSER_CHANNEL || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-prompt-evidence-'));

  try {
    await page.setContent('<main id="answer">old answer</main>');
    await saveEvidence({
      page,
      answerLocator: page.locator('#answer'),
      evidenceDir: tempDir,
      runName: 'qwen',
      result: { sample_id: '000067' },
    });

    await page.setContent('<main id="answer">new answer</main>');
    const files = await saveEvidence({
      page,
      answerLocator: page.locator('#answer'),
      evidenceDir: tempDir,
      runName: 'qwen',
      result: { sample_id: '000067' },
      overwriteExisting: true,
    });

    const sampleDir = path.join(tempDir, 'qwen', '000067');
    const names = (await fs.readdir(sampleDir)).sort();
    assert.deepEqual(names, ['answer.html', 'page.png']);
    assert.equal(await fs.readFile(path.join(sampleDir, 'answer.html'), 'utf8'), '<main id="answer">new answer</main>');
    assert.deepEqual(
      files.map((item) => item.replaceAll('\\', '/')),
      [
        path.relative(process.cwd(), path.join(sampleDir, 'page.png')).replaceAll('\\', '/'),
        path.relative(process.cwd(), path.join(sampleDir, 'answer.html')).replaceAll('\\', '/'),
      ],
    );
  } finally {
    await page.close();
    await browser.close();
  }
});
