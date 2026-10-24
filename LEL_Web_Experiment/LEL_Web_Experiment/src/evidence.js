import fs from 'node:fs/promises';
import path from 'node:path';
import { hashToUnitInterval, normalizePathForJson, safeFilePart } from './utils.js';

export function shouldSaveEvidence(result, options = {}) {
  const manualEvidenceIds = options.manualEvidenceIds ?? new Set();
  const sampleId = result.sample_id;

  if (options.overwriteResults === true) {
    return true;
  }

  if (manualEvidenceIds.has(sampleId)) {
    return true;
  }

  if (result.success === true) {
    return true;
  }

  if (result.error_type || result.success === false) {
    return true;
  }

  const rate = options.evidenceSampleRate ?? 0;
  return rate > 0 && hashToUnitInterval(`${result.platform}:${sampleId}`) < rate;
}

async function nextEvidencePath(sampleDir, basename, extension) {
  for (let index = 1; index < 10000; index += 1) {
    const suffix = index === 1 ? '' : `-${index}`;
    const candidate = path.join(sampleDir, `${basename}${suffix}${extension}`);
    try {
      await fs.access(candidate);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return candidate;
      }
      throw error;
    }
  }

  throw new Error(`Cannot allocate evidence path in ${sampleDir}`);
}

async function prepareEvidenceViewport(page, answerLocator) {
  try {
    await answerLocator.evaluate((element) => {
      const scrollToBottom = (target) => {
        if (!target) {
          return;
        }
        target.scrollTop = target.scrollHeight;
      };

      element.scrollIntoView({ block: 'end', inline: 'nearest' });

      let current = element.parentElement;
      for (let depth = 0; current && depth < 8; depth += 1) {
        const style = window.getComputedStyle(current);
        const overflow = `${style.overflow} ${style.overflowY}`;
        if (/(auto|scroll|overlay)/iu.test(overflow)) {
          scrollToBottom(current);
        }
        current = current.parentElement;
      }

      scrollToBottom(document.scrollingElement ?? document.documentElement);
      window.scrollTo(0, document.body.scrollHeight);
    });
  } catch {
    // Keep evidence best-effort. The caller will fall back to page-level capture.
  }

  for (let index = 0; index < 3; index += 1) {
    try {
      await answerLocator.scrollIntoViewIfNeeded({ timeout: 1500 });
    } catch {
      // Ignore unavailable answer locators and keep the page-level fallback.
    }
    await page.mouse.wheel(0, 900).catch(() => {});
    await page.waitForTimeout(250);
  }
}

export async function saveEvidence({ page, answerLocator, evidenceDir, runName, result, overwriteExisting = false }) {
  const sampleDir = path.resolve(evidenceDir, safeFilePart(runName), safeFilePart(result.sample_id));
  if (overwriteExisting) {
    await fs.rm(sampleDir, { recursive: true, force: true });
  }
  await fs.mkdir(sampleDir, { recursive: true });

  const files = [];
  const screenshotPath = await nextEvidencePath(sampleDir, 'page', '.png');
  await prepareEvidenceViewport(page, answerLocator);
  try {
    await answerLocator.screenshot({ path: screenshotPath, timeout: 5000 });
  } catch {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  }
  files.push(normalizePathForJson(path.relative(process.cwd(), screenshotPath)));

  const htmlPath = await nextEvidencePath(sampleDir, 'answer', '.html');
  let html = '';
  try {
    html = await answerLocator.evaluate((element) => element.outerHTML);
  } catch {
    html = await page.content();
  }
  await fs.writeFile(htmlPath, html, 'utf8');
  files.push(normalizePathForJson(path.relative(process.cwd(), htmlPath)));

  return files;
}
