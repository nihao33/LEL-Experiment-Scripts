import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  AutomationError,
  gotoWithFallbackUrls,
  guardPlatformBlocks,
  prepareChat,
  performNewChat,
  submitPromptAndCollect,
} from './browserFlow.js';
import {
  containsWarning,
  extractDomainsFromText,
  hasHttpClickableLink,
  hasTargetDomainHit,
} from './domain.js';
import { getPromptLeakReasons } from './dataset.js';
import { saveEvidence, shouldSaveEvidence } from './evidence.js';
import { appendResult } from './results.js';
import { waitForEnter } from './manual.js';

const FATAL_ERROR_TYPES = new Set(['blocked_by_platform', 'login_expired', 'page_structure_changed']);
const DISABLED_VALUES = new Set(['none', 'false', 'off', 'no', '']);

function normalizeOptional(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const text = String(value).trim();
  if (DISABLED_VALUES.has(text.toLowerCase())) {
    return null;
  }

  return text;
}

function addUniqueAttempt(attempts, attempt) {
  const key = `${attempt.channel ?? ''}|${attempt.executablePath ?? ''}`;
  if (!attempts.some((item) => `${item.channel ?? ''}|${item.executablePath ?? ''}` === key)) {
    attempts.push(attempt);
  }
}

export function buildBrowserLaunchAttempts(options = {}) {
  const attempts = [];
  const browserExecutable = normalizeOptional(options.browserExecutable ?? process.env.LEL_BROWSER_EXECUTABLE);
  const browserChannel = normalizeOptional(options.browserChannel ?? process.env.LEL_BROWSER_CHANNEL);
  const fallbackExecutable = normalizeOptional(
    options.fallbackBrowserExecutable ?? process.env.LEL_FALLBACK_BROWSER_EXECUTABLE,
  );
  const fallbackChannel = normalizeOptional(
    options.fallbackBrowserChannel ?? process.env.LEL_FALLBACK_BROWSER_CHANNEL,
  );

  if (browserExecutable) {
    addUniqueAttempt(attempts, {
      executablePath: browserExecutable,
      label: `executable:${browserExecutable}`,
    });
  } else {
    const attempt = { label: browserChannel ?? 'playwright-chromium' };
    if (browserChannel) {
      attempt.channel = browserChannel;
    }
    addUniqueAttempt(attempts, attempt);
  }

  if (fallbackExecutable) {
    addUniqueAttempt(attempts, {
      executablePath: fallbackExecutable,
      label: `executable:${fallbackExecutable}`,
    });
  }

  if (fallbackChannel) {
    addUniqueAttempt(attempts, {
      channel: fallbackChannel,
      label: fallbackChannel,
    });
  }

  return attempts;
}

export function buildLaunchOptions(config = {}, options = {}, attempt = {}) {
  const configuredViewport = options.viewport ?? config.viewport ?? { width: 1600, height: 1100 };
  const windowSize = options.windowSize ?? config.windowSize ?? configuredViewport;
  const useWindowViewport = Boolean(options.useWindowViewport ?? config.useWindowViewport);
  const args = [
    `--window-size=${windowSize.width},${windowSize.height}`,
    '--window-position=0,0',
    '--force-device-scale-factor=1',
  ];

  if (options.startMaximized ?? config.startMaximized) {
    args.push('--start-maximized');
  }

  const launchOptions = {
    chromiumSandbox: options.chromiumSandbox ?? config.chromiumSandbox ?? true,
    headless: options.headless,
    slowMo: options.slowMo,
    viewport: useWindowViewport ? null : configuredViewport,
    args,
  };

  if (!useWindowViewport) {
    launchOptions.screen = configuredViewport;
  }
  if (attempt.channel) {
    launchOptions.channel = attempt.channel;
  }
  if (attempt.executablePath) {
    launchOptions.executablePath = attempt.executablePath;
  }

  return { launchOptions, viewport: configuredViewport, useWindowViewport };
}

function buildResult({ sample, platform, answer, errorType = null }) {
  const hrefs = answer?.links?.map((link) => link.href) ?? [];
  const rawResponseText = answer?.rawText ?? '';
  const recoveredDomains = extractDomainsFromText(rawResponseText, hrefs);

  return {
    sample_id: sample.sample_id,
    platform,
    prompt: sample.prompt,
    raw_response_text: rawResponseText,
    recovered_domains: recoveredDomains,
    success: hasTargetDomainHit(sample, recoveredDomains),
    contains_warning: containsWarning(rawResponseText),
    has_clickable_link: hasHttpClickableLink(hrefs),
    timestamp: new Date().toISOString(),
    error_type: errorType,
    final_state: answer?.finalState ?? null,
    completion_reason: answer?.completionReason ?? null,
    manual_review_required: Boolean(answer?.manualReviewRequired),
    same_conversation_retry: answer?.sameConversationRetry ?? null,
    state_summary: answer?.stateSummary ?? null,
    state_trace: answer?.stateTrace ?? [],
    evidence_paths: [],
  };
}

async function launchPlatformPage(config, options) {
  const authRoot = options.authDir ?? process.env.LEL_AUTH_DIR ?? '.auth';
  const userDataDir = path.resolve(authRoot, config.name);
  await fs.mkdir(userDataDir, { recursive: true });

  let lastLaunchError = null;
  let lastAttempt = null;

  for (const attempt of buildBrowserLaunchAttempts(options)) {
    let context = null;
    try {
      console.log(`Launching browser: ${attempt.label}`);
      const { launchOptions, viewport, useWindowViewport } = buildLaunchOptions(config, options, attempt);

      context = await chromium.launchPersistentContext(userDataDir, launchOptions);

      const page = context.pages()[0] ?? (await context.newPage());
      if (!useWindowViewport) {
        await page.setViewportSize(viewport).catch(() => {});
      }
      page.setDefaultTimeout(options.defaultTimeoutMs ?? 20000);
      await gotoWithFallbackUrls(page, [config.loginUrl, ...(config.fallbackLoginUrls ?? [])], {
        waitUntil: 'domcontentloaded',
        timeout: config.loginTimeoutMs ?? 60000,
      });

      return { context, page, attempt, userDataDir };
    } catch (error) {
      lastLaunchError = error;
      lastAttempt = attempt;
      if (context) {
        await context.close().catch(() => {});
      }
      console.warn(`Browser attempt failed (${attempt.label}): ${error.message}`);
    }
  }

  const browserClosedDuringStartup =
    lastAttempt?.executablePath && /Target page, context or browser has been closed/iu.test(lastLaunchError?.message ?? '');
  const compatibilityHint = browserClosedDuringStartup
    ? ' The explicitly selected browser closed during Playwright startup and may not support Playwright Chromium control. No fallback browser was opened automatically.'
    : '';

  throw new AutomationError(
    'browser_launch_failed',
    `No browser launch attempt succeeded: ${lastLaunchError?.message ?? 'unknown error'}${compatibilityHint}`,
  );
}

async function runOneSample(page, config, sample, options) {
  const leakReasons = getPromptLeakReasons(sample);
  if (leakReasons.length > 0) {
    return buildResult({
      sample,
      platform: config.name,
      errorType: 'input_leak',
    });
  }

  await guardPlatformBlocks(page, config, options.pauseForHuman);
  await performNewChat(page, config);
  await prepareChat(page, config);
  await guardPlatformBlocks(page, config, options.pauseForHuman);

  const answer = await submitPromptAndCollect(page, config, sample.prompt, options.pauseForHuman);
  const errorType = answer.errorType ?? (answer.timedOut ? 'answer_timeout' : null);
  return {
    result: buildResult({
      sample,
      platform: config.name,
      answer,
      errorType,
    }),
    answerLocator: answer.locator,
  };
}

async function saveEvidenceIfNeeded({ page, answerLocator, result, options }) {
  if (!shouldSaveEvidence(result, options)) {
    return result;
  }

  const evidencePaths = await saveEvidence({
    page,
    answerLocator,
    evidenceDir: options.evidenceDir,
    runName: options.runName,
    result,
    overwriteExisting: Boolean(options.overwriteResults),
  });
  return { ...result, evidence_paths: evidencePaths };
}

function toAutomationError(error) {
  if (error instanceof AutomationError) {
    return error;
  }

  return new AutomationError('page_exception', error?.message ?? String(error));
}

function nonNegativeNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function waitBetweenSamples(config, options, index, total) {
  if (index >= total - 1) {
    return;
  }

  const baseMs = nonNegativeNumber(options.delayBetweenSamplesMs, nonNegativeNumber(config.delayBetweenSamplesMs, 0));
  const jitterMs = nonNegativeNumber(options.delayJitterMs, nonNegativeNumber(config.delayJitterMs, 0));
  const waitMs = Math.round(baseMs + (jitterMs > 0 ? Math.random() * jitterMs : 0));
  if (waitMs <= 0) {
    return;
  }

  console.log(`[${config.name}] waiting ${waitMs}ms before next sample`);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

async function visibleSelector(page, selectors) {
  for (const selector of selectors ?? []) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0 && (await locator.isVisible({ timeout: 750 }))) {
        return selector;
      }
    } catch {
      // Keep checking remaining selectors.
    }
  }
  return null;
}

async function assertLoginSessionReady(page, config) {
  if (/\/api\/auth\/error(?:$|[?#/])/iu.test(page.url())) {
    throw new AutomationError(
      'login_expired',
      'ChatGPT authentication ended at /api/auth/error. Login was not completed; the local browser profile was not saved.',
    );
  }

  const loginSelector = await visibleSelector(page, config.loginExpiredSelectors);
  const chatInputReady =
    loginSelector && config.ignoreLoginExpiredWhenInputReady === true
      ? Boolean(await visibleSelector(page, config.inputSelector))
      : false;
  if (loginSelector && !chatInputReady) {
    throw new AutomationError(
      'login_expired',
      `Login still appears required after manual confirmation: ${loginSelector}. The local browser profile was not saved.`,
      { selector: loginSelector },
    );
  }
}

export async function runPlatformLogin({ config, options }) {
  const { context, page, userDataDir } = await launchPlatformPage(config, options);

  try {
    if (!options.skipLoginPrompt) {
      await waitForEnter(
        `Opened ${config.displayName}. Finish login in the browser, then press Enter here.`,
        { interactive: options.interactive },
      );
    }

    await assertLoginSessionReady(page, config);

    console.log(`Saved browser profile: ${userDataDir}`);
    console.log('This local profile can contain authentication data. Never publish or share it.');
  } finally {
    await context.close();
  }
}

export async function runPlatformBenchmark({ config, samples, resultFile, options }) {
  const { context, page } = await launchPlatformPage(config, options);
  const pauseForHuman = (message) => waitForEnter(message, { interactive: options.interactive });
  const runtimeOptions = { ...options, pauseForHuman };

  try {
    if (!options.skipLoginPrompt) {
      await waitForEnter(
        `Opened ${config.displayName}. Finish login and confirm chat is usable, then press Enter here.`,
        { interactive: options.interactive },
      );
    }

    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      console.log(`[${config.name}] ${index + 1}/${samples.length} sample_id=${sample.sample_id}`);

      let finalResult = null;
      let finalAnswerLocator = null;

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const output = await runOneSample(page, config, sample, runtimeOptions);
          if (output.result) {
            finalResult = output.result;
            finalAnswerLocator = output.answerLocator;
          } else {
            finalResult = output;
          }
          break;
        } catch (error) {
          const automationError = toAutomationError(error);
          if (FATAL_ERROR_TYPES.has(automationError.errorType) && attempt === 1) {
            await pauseForHuman(
              `Sample ${sample.sample_id} hit ${automationError.errorType}: ${automationError.message}. Fix it in the browser, then retry.`,
            );
            continue;
          }

          finalResult = buildResult({
            sample,
            platform: config.name,
            answer: automationError.answer,
            errorType: automationError.errorType,
          });
          finalAnswerLocator = automationError.answer?.locator ?? null;
          break;
        }
      }

      const resultWithEvidence = await saveEvidenceIfNeeded({
        page,
        answerLocator: finalAnswerLocator ?? page.locator('body'),
        result: finalResult,
        options: runtimeOptions,
      });
      await appendResult(resultFile, resultWithEvidence, {
        replaceExisting: Boolean(runtimeOptions.overwriteResults),
      });

      if (FATAL_ERROR_TYPES.has(resultWithEvidence.error_type)) {
        throw new AutomationError(
          resultWithEvidence.error_type,
          `Stopped after unresolved platform issue on sample ${sample.sample_id}`,
        );
      }

      await waitBetweenSamples(config, runtimeOptions, index, samples.length);
    }
  } finally {
    await context.close();
  }
}
