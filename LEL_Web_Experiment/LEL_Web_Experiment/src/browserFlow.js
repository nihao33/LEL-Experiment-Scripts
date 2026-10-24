export class AutomationError extends Error {
  constructor(errorType, message, options = {}) {
    super(message);
    this.name = 'AutomationError';
    this.errorType = errorType;
    this.selector = options.selector;
    this.answer = options.answer;
  }
}

function asArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

const DEFAULT_SEND_BUTTON_SELECTORS = [
  "button[type='submit']",
  "button[data-testid*='send' i]",
  "[role='button'][data-testid*='send' i]",
  "button[class*='send' i]",
  "[role='button'][class*='send' i]",
  "button[aria-label*='Send' i]",
  "[role='button'][aria-label*='Send' i]",
  "button[aria-label*='\u53d1\u9001']",
  "[role='button'][aria-label*='\u53d1\u9001']",
  "button[title*='Send' i]",
  "button[title*='\u53d1\u9001']",
  "button:has-text('Send')",
  "button:has-text('\u53d1\u9001')",
  "[role='button']:has-text('Send')",
  "[role='button']:has-text('\u53d1\u9001')",
];

function mergeSelectors(...groups) {
  return [...new Set(groups.flatMap((group) => asArray(group)))];
}

async function isVisible(locator) {
  try {
    return (await locator.count()) > 0 && (await locator.isVisible());
  } catch {
    return false;
  }
}

export async function firstVisibleLocator(page, selectors, { timeoutMs = 15000, label = 'selector' } = {}) {
  const selectorList = asArray(selectors);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of selectorList) {
      const locator = page.locator(selector).first();
      if (await isVisible(locator)) {
        return { locator, selector };
      }
    }
    await page.waitForTimeout(250);
  }

  throw new AutomationError('page_structure_changed', `Cannot find visible ${label}`, {
    selector: selectorList.join(' | '),
  });
}

async function findVisibleSelector(page, selectors) {
  for (const selector of asArray(selectors)) {
    if (textRegexSelector(selector) && (await visibleTextRegexSelectorExists(page, selector))) {
      return selector;
    }

    const locator = page.locator(selector).first();
    if (await isVisible(locator)) {
      return selector;
    }
  }
  return null;
}

function textRegexSelector(selector) {
  return String(selector ?? '').match(/^text=\/(.+)\/([a-z]*)$/su);
}

async function visibleTextRegexSelectorExists(page, selector) {
  const match = textRegexSelector(selector);
  if (!match) {
    return false;
  }

  return page
    .evaluate(
      ({ source, flags }) => {
        const safeFlags = String(flags ?? '').replace(/g/gu, '');
        const pattern = new RegExp(source, safeFlags);
        const ignoredTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'USE', 'HEAD', 'META', 'LINK']);
        const visible = (element, rect) => {
          const style = window.getComputedStyle(element);
          return (
            rect.width >= 8 &&
            rect.height >= 8 &&
            rect.bottom >= 0 &&
            rect.top <= window.innerHeight &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            Number(style.opacity || 1) > 0.05
          );
        };

        for (const element of document.querySelectorAll('body *')) {
          if (ignoredTags.has(element.tagName)) {
            continue;
          }

          const rect = element.getBoundingClientRect();
          if (!visible(element, rect)) {
            continue;
          }

          const ownText = Array.from(element.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent ?? '')
            .join(' ')
            .replace(/\s+/gu, ' ')
            .trim();
          const ariaText = [element.getAttribute('aria-label'), element.getAttribute('title')]
            .filter(Boolean)
            .join(' ')
            .trim();
          const directText = [ownText, ariaText].filter(Boolean).join(' ').trim();
          if (directText && directText.length <= 260 && pattern.test(directText)) {
            return true;
          }

          const text = String(element.innerText ?? '').replace(/\s+/gu, ' ').trim();
          const hasVisibleElementChildren = Array.from(element.children).some((child) => {
            if (ignoredTags.has(child.tagName)) {
              return false;
            }
            const childRect = child.getBoundingClientRect();
            return visible(child, childRect);
          });
          if (!hasVisibleElementChildren && text && text.length <= 260 && pattern.test(text)) {
            return true;
          }
        }

        return false;
      },
      { source: match[1], flags: match[2] },
    )
    .catch(() => false);
}

async function findExistingSelector(page, selectors) {
  for (const selector of asArray(selectors)) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) > 0) {
        return selector;
      }
    } catch {
      // Keep checking the remaining selectors.
    }
  }
  return null;
}

function selectorNeedsExistingBlockCheck(selector) {
  return /cf-turnstile-response|cf-chl|turnstile|iframe\[src\*=['"]?captcha|script:has-text\(['"]?_cf_chl_opt/iu.test(
    String(selector ?? ''),
  );
}

function existingPlatformBlockSelectors(config) {
  return mergeSelectors(
    config.hiddenBlockSelectors,
    config.blockingExistingSelectors,
    asArray(config.captchaOrRiskSelectors).filter(selectorNeedsExistingBlockCheck),
  );
}

async function visibleBlockResolvedSelector(page, config) {
  for (const selector of mergeSelectors(config.blockResolvedSelectors, config.inputSelector)) {
    const locator = page.locator(selector).first();
    if (await isVisible(locator)) {
      return selector;
    }
  }
  return null;
}

async function platformBlockSelector(page, config) {
  const existingBlockSelector = await findExistingSelector(page, existingPlatformBlockSelectors(config));
  if (existingBlockSelector) {
    const resolvedSelector = await visibleBlockResolvedSelector(page, config);
    if (!resolvedSelector) {
      return existingBlockSelector;
    }
  }

  return findVisibleSelector(page, config.captchaOrRiskSelectors);
}

async function selectorText(page, selector) {
  if (!selector) {
    return '';
  }
  return page
    .locator(selector)
    .first()
    .textContent({ timeout: 500 })
    .then((text) => text?.trim() ?? '')
    .catch(() => '');
}

async function pagePlatformIssueSignal(page, config) {
  const serviceSelector = await configuredStateSelectorVisible(page, config, [
    'serviceIssueSelector',
    'serviceIssueSelectors',
    'serviceSelector',
    'serviceSelectors',
  ]);
  if (serviceSelector) {
    const rawText = (await selectorText(page, serviceSelector)) || 'Platform service issue detected.';
    return {
      state: 'service_issue',
      errorType: 'service_unavailable',
      selector: serviceSelector,
      rawText,
    };
  }

  return null;
}

function buildPlatformIssueAnswer(page, issue) {
  const now = new Date().toISOString();
  return {
    locator: issue.selector ? page.locator(issue.selector).first() : page.locator('body'),
    rawText: issue.rawText ?? issue.errorType,
    links: [],
    isIntermediate: false,
    isRefusal: false,
    timedOut: false,
    errorType: issue.errorType,
    finalState: issue.state,
    completionReason: issue.errorType,
    manualReviewRequired: true,
    stateTrace: [
      {
        timestamp: now,
        state: issue.state,
        error_type: issue.errorType,
        manual_review_required: true,
        selectors: { serviceIssue: issue.selector ?? null },
      },
    ],
    stateSummary: {
      final_state: issue.state,
      completion_reason: issue.errorType,
      total_snapshots: 1,
      last_snapshot: {
        timestamp: now,
        state: issue.state,
        error_type: issue.errorType,
        manual_review_required: true,
        selectors: { serviceIssue: issue.selector ?? null },
      },
    },
  };
}

async function recentlyClickedRecoverableRetry(page, config) {
  const cooldownMs = config.recoverableRetryCooldownMs ?? 15000;
  return page
    .evaluate((cooldown) => {
      const lastClickAt = window.__webPromptRecoverableRetryClickedAt ?? 0;
      return Date.now() - lastClickAt < cooldown;
    }, cooldownMs)
    .catch(() => false);
}

async function clickRecoverableRetryNearError(page, recoverableSelector) {
  const errorLocator = page.locator(recoverableSelector).first();
  if (!(await isVisible(errorLocator))) {
    return false;
  }

  return errorLocator
    .evaluate((errorElement) => {
      const retryWords = /\u5237\u65b0|\u91cd\u8bd5|\u91cd\u65b0\u751f\u6210|\u518d\u8bd5\u4e00\u6b21|retry|refresh|reload|regenerate/iu;
      const ignoreWords = /\u5347\u7ea7|\u767b\u5f55|\u65b0\u5efa|\u65b0\u4f1a\u8bdd|\u5386\u53f2|ppt|\u6587\u6863|\u6df1\u5ea6\u7814\u7a76|\u7f51\u7ad9|\u8868\u683c|agent|code|claw|share|\u5206\u4eab/iu;
      const visible = (element, rect) => {
        const style = window.getComputedStyle(element);
        return (
          rect.width >= 8 &&
          rect.height >= 8 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          Number(style.opacity || 1) > 0.05
        );
      };
      const textFor = (element) =>
        [
          element.textContent,
          element.getAttribute?.('aria-label'),
          element.getAttribute?.('title'),
          element.getAttribute?.('data-testid'),
          element.className?.toString(),
        ]
          .filter(Boolean)
          .join(' ')
          .trim();
      const clickableFor = (element) =>
        element.closest?.('button,[role="button"],a,[tabindex]') ?? element.parentElement ?? element;

      const errorRect = errorElement.getBoundingClientRect();
      const roots = [];
      let current = errorElement;
      for (let depth = 0; current && depth < 8; depth += 1) {
        roots.push(current);
        current = current.parentElement;
      }

      const candidates = [];
      for (const root of roots) {
        candidates.push(
          ...root.querySelectorAll(
            'button,[role="button"],a,[tabindex],svg,[class*="retry"],[class*="refresh"],[class*="reload"],[class*="regenerate"]',
          ),
        );
      }

      let best = null;
      const seen = new Set();
      for (const rawCandidate of candidates) {
        const candidate = clickableFor(rawCandidate);
        if (!candidate || seen.has(candidate)) {
          continue;
        }
        seen.add(candidate);

        const rect = candidate.getBoundingClientRect();
        if (!visible(candidate, rect)) {
          continue;
        }

        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const nearErrorX = centerX >= errorRect.left - 120 && centerX <= errorRect.right + 160;
        const nearErrorY = centerY >= errorRect.top - 30 && centerY <= errorRect.bottom + 170;
        if (!nearErrorX || !nearErrorY) {
          continue;
        }

        const text = textFor(candidate);
        let score = 0;
        if (retryWords.test(text)) {
          score += 140;
        }
        if (ignoreWords.test(text)) {
          score -= 180;
        }
        if (candidate.matches('button,[role="button"],a,[tabindex]')) {
          score += 40;
        }
        if (candidate.querySelector('svg') || rawCandidate.tagName?.toLowerCase() === 'svg') {
          score += 45;
        }
        if (centerY >= errorRect.bottom - 10) {
          score += 35;
        }
        if (rect.width <= 70 && rect.height <= 70) {
          score += 25;
        }
        if (Math.abs(centerX - errorRect.left) < 90) {
          score += 20;
        }

        if (!best || score > best.score) {
          best = { element: candidate, score };
        }
      }

      if (!best || best.score < 70) {
        return false;
      }

      best.element.click();
      window.__webPromptRecoverableRetryClickedAt = Date.now();
      return true;
    })
    .catch(() => false);
}

export async function guardPlatformBlocks(page, config, pauseForHuman) {
  const recoverableSelector = await findVisibleSelector(page, config.recoverableErrorSelectors);
  if (recoverableSelector) {
    if (await recentlyClickedRecoverableRetry(page, config)) {
      return;
    }

    let clickedRecovery = false;
    if (config.clickRecoverableRetryNearError !== false) {
      clickedRecovery = await clickRecoverableRetryNearError(page, recoverableSelector);
    }

    const actions = config.recoverableErrorActions?.actions ?? config.recoverableErrorActions ?? [];
    let actionRan = false;
    for (const action of actions) {
      try {
        await runAction(page, action, config);
        actionRan = true;
      } catch (error) {
        if (!action.optional) {
          throw error;
        }
      }
    }

    if (clickedRecovery || actionRan) {
      await page.waitForTimeout(config.recoverableErrorWaitMs ?? 5000);
    }

    const stillRecoverable = await findVisibleSelector(page, config.recoverableErrorSelectors);
    if (stillRecoverable) {
      if (clickedRecovery || (await recentlyClickedRecoverableRetry(page, config))) {
        return;
      }
      await pauseForHuman(`Recoverable platform issue: ${stillRecoverable}. Click refresh/retry in the browser.`);
      const unresolved = await findVisibleSelector(page, config.recoverableErrorSelectors);
      if (unresolved) {
        throw new AutomationError('blocked_by_platform', `Recoverable platform issue persisted: ${unresolved}`, {
          selector: unresolved,
        });
      }
    }
  }

  const captchaSelector = await platformBlockSelector(page, config);
  if (captchaSelector) {
    await pauseForHuman(`Blocked by platform selector: ${captchaSelector}. Fix it in the browser.`);
    const stillBlocked = await platformBlockSelector(page, config);
    if (stillBlocked) {
      throw new AutomationError('blocked_by_platform', `Blocked by platform selector: ${stillBlocked}`, {
        selector: stillBlocked,
      });
    }
  }

  const loginSelector = await findVisibleSelector(page, config.loginExpiredSelectors);
  const chatInputReady =
    loginSelector && config.ignoreLoginExpiredWhenInputReady === true
      ? Boolean(await findVisibleSelector(page, config.inputSelector))
      : false;
  if (loginSelector && !chatInputReady) {
    await pauseForHuman(`Login is required or expired: ${loginSelector}. Log in again in the browser.`);
    const stillExpired = await findVisibleSelector(page, config.loginExpiredSelectors);
    const chatInputReadyAfterLogin =
      stillExpired && config.ignoreLoginExpiredWhenInputReady === true
        ? Boolean(await findVisibleSelector(page, config.inputSelector))
        : false;
    if (stillExpired && !chatInputReadyAfterLogin) {
      throw new AutomationError('login_expired', `Login expired selector: ${stillExpired}`, {
        selector: stillExpired,
      });
    }
  }
}

async function elementLooksActive(locator) {
  return locator.evaluate((element) => {
    const isBlueish = (value) => {
      const match = String(value).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/iu);
      if (!match) {
        return false;
      }
      const red = Number(match[1]);
      const green = Number(match[2]);
      const blue = Number(match[3]);
      return blue >= 150 && blue > red + 30 && blue >= green;
    };
    const activeValues = new Set(['true', 'checked', 'on', 'active', 'selected']);
    let current = element;
    let depth = 0;
    while (current && depth < 6) {
      const attr = (name) => current.getAttribute?.(name);
      const classes = current.className?.toString().toLowerCase() ?? '';
      const styles = window.getComputedStyle(current);
      const pressed = (attr('aria-pressed') ?? attr('aria-checked') ?? attr('data-state') ?? attr('data-active') ?? '')
        .toLowerCase();
      if (
        activeValues.has(pressed) ||
        /\b(active|selected|checked|on)\b/u.test(classes) ||
        isBlueish(styles.color) ||
        isBlueish(styles.borderColor)
      ) {
        return true;
      }
      current = current.parentElement;
      depth += 1;
    }
    return false;
  });
}

export async function gotoWithFallbackUrls(page, urls, { waitUntil = 'domcontentloaded', timeout } = {}) {
  const candidates = [...new Set(asArray(urls).map((url) => String(url ?? '').trim()).filter(Boolean))];
  let lastError = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const url = candidates[index];
    try {
      await page.goto(url, { waitUntil, timeout });
      return url;
    } catch (error) {
      lastError = error;
      if (index < candidates.length - 1) {
        console.warn(`Navigation failed for ${url}; trying configured fallback URL.`);
        // Chromium may still be committing its internal error page after a network-level failure.
        await page.waitForTimeout(300);
      }
    }
  }

  throw lastError ?? new AutomationError('invalid_platform_config', 'No navigation URL was configured');
}

async function runAction(page, action, config) {
  const timeoutMs = action.timeoutMs ?? config.actionTimeoutMs ?? 15000;

  if (action.type === 'goto') {
    await gotoWithFallbackUrls(page, [action.url, ...asArray(action.fallbackUrls)], {
      waitUntil: action.waitUntil ?? 'domcontentloaded',
      timeout: timeoutMs,
    });
    return;
  }

  if (action.type === 'click' || action.type === 'clickAny') {
    const selectors = action.type === 'clickAny' ? action.selectors : action.selector;
    const { locator } = await firstVisibleLocator(page, selectors, {
      timeoutMs,
      label: action.label ?? 'click target',
    });
    await locator.click({ timeout: timeoutMs });
    return;
  }

  if (action.type === 'ensureToggleOn') {
    if (action.activeSelectors && (await findVisibleSelector(page, action.activeSelectors))) {
      return;
    }

    const { locator } = await firstVisibleLocator(page, action.selectors ?? action.selector, {
      timeoutMs,
      label: action.label ?? 'toggle',
    });

    const looksActive = await elementLooksActive(locator).catch(() => false);
    const shouldClick = action.clickWhenUnknown ? !looksActive : !looksActive;
    if (shouldClick) {
      await locator.click({ timeout: timeoutMs });
      if (action.afterClickDelayMs) {
        await page.waitForTimeout(action.afterClickDelayMs);
      }
    }
    return;
  }

  if (action.type === 'keyboard') {
    await page.keyboard.press(action.key);
    return;
  }

  if (action.type === 'waitForSelector') {
    await firstVisibleLocator(page, action.selector, {
      timeoutMs,
      label: action.label ?? action.selector,
    });
    return;
  }

  if (action.type === 'delay') {
    await page.waitForTimeout(action.ms ?? 1000);
    return;
  }

  if (action.type === 'none') {
    return;
  }

  throw new AutomationError('invalid_platform_config', `Unsupported action type: ${action.type}`);
}

export async function performNewChat(page, config) {
  const actions = config.newChat?.actions ?? [config.newChat];
  for (const action of actions) {
    try {
      await runAction(page, action, config);
    } catch (error) {
      if (action.optional) {
        continue;
      }
      throw error;
    }
  }

  await firstVisibleLocator(page, config.inputSelector, {
    timeoutMs: config.inputTimeoutMs ?? 20000,
    label: 'input box',
  });
}

export async function prepareChat(page, config) {
  const actions = config.prepareChat?.actions ?? config.prepareChat ?? [];
  for (const action of actions) {
    try {
      await runAction(page, action, config);
    } catch (error) {
      if (action.optional) {
        continue;
      }
      throw error;
    }
  }
}

async function assistantLocatorWithCount(page, selectors) {
  const selectorList = mergeSelectors(selectors, [
    "[data-message-author-role='assistant']",
    "[data-role='assistant']",
    "[data-message-id] [class*='md-box-root']",
    "[data-message-id] [data-render-engine='node']",
    "[class*='model-response']",
    "[class*='response-content']",
    "[class*='assistant']",
    "[class*='markdown']",
    ".markdown",
  ]);

  for (const selector of selectorList) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count > 0) {
      return { locator, selector, count };
    }
  }
  return null;
}

async function waitForAssistantStart(page, config, { beforeCount = 0, beforeText = '', prompt = '' } = {}, pauseForHuman = async () => {}) {
  const timeoutMs = config.answerStartTimeoutMs ?? 45000;
  const minStartChars = config.answerStartMinChars ?? 12;
  let deadline = Date.now() + timeoutMs;

  while (true) {
    const platformIssue = await pagePlatformIssueSignal(page, config);
    if (platformIssue) {
      return { platformIssue };
    }

    const active = await assistantLocatorWithCount(page, config.assistantMessageSelector);

    const response = await extractLatestAssistantResponse(page, config, { prompt }).catch(() => null);
    if (response) {
      const currentCompact = String(response.rawText ?? '').replace(/\s+/gu, '').trim();
      const beforeCompact = String(beforeText ?? '').replace(/\s+/gu, '').trim();
      const validResponseShape =
        currentCompact.length >= minStartChars &&
        !textLooksLikePromptEcho(response.rawText, prompt) &&
        !textLooksPageChrome(response.rawText) &&
        !textLooksConversationContainer(response.rawText, prompt);
      const changedEnough =
        validResponseShape &&
        currentCompact !== beforeCompact;
      const newAssistantNode = validResponseShape && active && active.count > beforeCount;
      if (changedEnough || newAssistantNode) {
        return active ?? { locator: response.locator, selector: 'text-change', count: beforeCount };
      }
    }

    if ((await stopButtonVisible(page, config)) || (await activityIndicatorVisible(page, config))) {
      return active ?? { locator: page.locator('body'), selector: 'generation-activity', count: beforeCount };
    }

    await page.waitForTimeout(300);

    if (Date.now() >= deadline) {
      if (config.pauseOnAnswerTimeout === false) {
        throw new AutomationError('answer_timeout', 'Assistant answer did not start before timeout');
      }
      await pauseForHuman(
        `回答还没有开始。请在浏览器里确认提示词是否已发送、是否需要点重试/刷新、是否有登录或平台限制；处理后按 Enter，脚本会继续等待这一条样本。`,
      );
      await guardPlatformBlocks(page, config, pauseForHuman);
      deadline = Date.now() + timeoutMs;
    }
  }
}

async function stopButtonVisible(page, config) {
  const stopSelectors = config.streamingDone?.stopButtonSelector ?? config.streamingDone?.stopButtonSelectors;
  const visible = await findVisibleSelector(page, stopSelectors);
  if (visible) {
    return true;
  }

  if (config.streamingDone?.detectLikelyStopButton === false) {
    return false;
  }

  return page
    .evaluate(() => {
      const visibleElement = (element, rect) => {
        const style = window.getComputedStyle(element);
        return (
          rect.width >= 18 &&
          rect.height >= 18 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          Number(style.opacity || 1) > 0.05
        );
      };
      const colorLooksActive = (value) => {
        const match = String(value).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/iu);
        if (!match) {
          return false;
        }
        const red = Number(match[1]);
        const green = Number(match[2]);
        const blue = Number(match[3]);
        return blue >= 120 || (red >= 50 && red <= 190 && green >= 50 && green <= 190 && blue >= 50 && blue <= 190);
      };
      const textFor = (element) =>
        [
          element.textContent,
          element.getAttribute?.('aria-label'),
          element.getAttribute?.('title'),
          element.getAttribute?.('data-testid'),
          element.id,
          element.className?.toString(),
        ]
          .filter(Boolean)
          .join(' ');
      const inputs = Array.from(document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]'));
      const inputRects = inputs
        .map((input) => input.getBoundingClientRect())
        .filter((rect) => rect.width >= 120 && rect.height >= 20 && rect.bottom >= 0 && rect.top <= window.innerHeight);
      const latestInputRect = inputRects.at(-1) ?? {
        left: window.innerWidth * 0.25,
        right: window.innerWidth,
        top: window.innerHeight - 180,
        bottom: window.innerHeight,
        width: window.innerWidth * 0.75,
      };
      const candidates = Array.from(
        document.querySelectorAll(
          'button,[role="button"],[class*="stop"],[class*="pause"],[class*="break"],[id*="stop"],[id*="pause"],[id*="break"],[id*="end-msg"]',
        ),
      );

      for (const element of candidates) {
        const rect = element.getBoundingClientRect();
        if (!visibleElement(element, rect)) {
          continue;
        }

        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const nearInput =
          centerY >= latestInputRect.top - 120 &&
          centerY <= latestInputRect.bottom + 120 &&
          centerX >= latestInputRect.left + latestInputRect.width * 0.55;
        if (!nearInput) {
          continue;
        }

        const text = textFor(element);
        if (/stop|pause|break|\u505c\u6b62|\u6682\u505c|\u4e2d\u6b62|break-btn|end-msg/iu.test(text)) {
          return true;
        }

        const smallIconButton = rect.width <= 70 && rect.height <= 70 && element.querySelector('svg,path,rect');
        const style = window.getComputedStyle(element);
        const hasStopLikeShape =
          element.querySelector('rect') ||
          Array.from(element.querySelectorAll('path')).some((path) => {
            const d = path.getAttribute('d') ?? '';
            return /(?:H|h|V|v).{0,80}(?:H|h|V|v)/u.test(d) && /(?:7\.5|8\.0|16\.5|15\.9|12\.5)/u.test(d);
          });
        if (
          smallIconButton &&
          hasStopLikeShape &&
          (colorLooksActive(style.backgroundColor) ||
            colorLooksActive(style.color) ||
            colorLooksActive(style.borderColor) ||
            !/send|submit|arrow[-_ ]?up|upload|\u53d1\u9001|\u4e0a\u4f20/iu.test(text))
        ) {
          return true;
        }
      }

      return false;
    })
    .catch(() => false);
}

async function composerReadyVisible(page, config) {
  const readySelectors = config.streamingDone?.sendReadySelector ?? config.streamingDone?.sendReadySelectors;
  if (await findVisibleSelector(page, readySelectors)) {
    return true;
  }

  if (config.streamingDone?.detectLikelySendReadyButton === false) {
    return null;
  }

  return page
    .evaluate(() => {
      const visibleElement = (element, rect) => {
        const style = window.getComputedStyle(element);
        return (
          rect.width >= 18 &&
          rect.height >= 18 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          Number(style.opacity || 1) > 0.05
        );
      };
      const textFor = (element) =>
        [
          element.textContent,
          element.getAttribute?.('aria-label'),
          element.getAttribute?.('title'),
          element.getAttribute?.('data-testid'),
          element.id,
          element.className?.toString(),
          Array.from(element.querySelectorAll('svg,use,path,rect'))
            .map((node) =>
              [
                node.getAttribute?.('aria-label'),
                node.getAttribute?.('class'),
                node.getAttribute?.('href'),
                node.getAttribute?.('xlink:href'),
                node.getAttribute?.('d'),
              ]
                .filter(Boolean)
                .join(' '),
            )
            .join(' '),
        ]
          .filter(Boolean)
          .join(' ');
      const inputs = Array.from(document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]'));
      const inputRects = inputs
        .map((input) => input.getBoundingClientRect())
        .filter((rect) => rect.width >= 120 && rect.height >= 20 && rect.bottom >= 0 && rect.top <= window.innerHeight);
      const latestInputRect = inputRects.at(-1) ?? {
        left: window.innerWidth * 0.25,
        right: window.innerWidth,
        top: window.innerHeight - 180,
        bottom: window.innerHeight,
        width: window.innerWidth * 0.75,
      };
      const candidates = Array.from(document.querySelectorAll('button,[role="button"]'));
      let sawComposerButton = false;

      for (const element of candidates) {
        const rect = element.getBoundingClientRect();
        if (!visibleElement(element, rect)) {
          continue;
        }

        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const nearInput =
          centerY >= latestInputRect.top - 120 &&
          centerY <= latestInputRect.bottom + 120 &&
          centerX >= latestInputRect.left + latestInputRect.width * 0.5;
        const iconButton = rect.width <= 82 && rect.height <= 82 && element.querySelector('svg,path,use,rect');
        if (!nearInput || !iconButton) {
          continue;
        }

        const text = textFor(element);
        if (/microphone|mic|voice|\u8bed\u97f3|\u9ea6\u514b\u98ce|\u5f55\u97f3/iu.test(text)) {
          continue;
        }
        sawComposerButton = true;

        if (/stop|pause|break|\u505c\u6b62|\u6682\u505c|\u4e2d\u6b62|break-btn|end-msg|icon-stop/iu.test(text)) {
          return false;
        }
        if (element.querySelector('rect')) {
          return false;
        }
        const hasStopLikePath = Array.from(element.querySelectorAll('path')).some((path) => {
          const d = path.getAttribute('d') ?? '';
          return /(?:H|h|V|v).{0,80}(?:H|h|V|v)/u.test(d) && /(?:7\.5|8\.0|16\.5|15\.9|12\.5)/u.test(d);
        });
        if (hasStopLikePath) {
          return false;
        }

        if (/send|submit|arrow[-_ ]?up|up[-_ ]?arrow|upload|paper[-_ ]?plane|icon-send|\u53d1\u9001|\u4e0a\u4f20/iu.test(text)) {
          return true;
        }

        const hasUpArrowPath = Array.from(element.querySelectorAll('path')).some((path) => {
          const d = path.getAttribute('d') ?? '';
          return /(?:M|m).{0,80}(?:L|l).{0,80}(?:7|8|12|16|17).{0,80}(?:V|v|L|l)/u.test(d);
        });
        if (hasUpArrowPath || (centerX >= latestInputRect.left + latestInputRect.width * 0.72 && !element.disabled)) {
          return true;
        }
      }

      return sawComposerButton ? false : null;
    })
    .catch(() => null);
}

async function activityIndicatorVisible(page, config) {
  const activitySelectors = [
    ...asArray(config.streamingDone?.activitySelectors),
    ...asArray(config.streamingDone?.intermediateSelectors),
    ...asArray(config.streamingDone?.thinkingSelectors),
  ];
  if (activitySelectors.length === 0) {
    return false;
  }
  return Boolean(await findVisibleSelector(page, activitySelectors));
}

async function setPromptValue(page, inputLocator, prompt) {
  await inputLocator.click();
  try {
    await inputLocator.fill(prompt);
  } catch {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.insertText(prompt);
  }

  const actualText = await inputLocator
    .evaluate((element) => ('value' in element ? element.value : element.innerText ?? element.textContent ?? ''))
    .catch(() => '');
  const normalize = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (normalize(actualText) !== normalize(prompt)) {
    throw new AutomationError('prompt_input_failed', 'Prompt text was not fully written into the input box');
  }
}

async function inputText(inputLocator) {
  return inputLocator
    .evaluate((element) => ('value' in element ? element.value : element.innerText ?? element.textContent ?? ''))
    .catch(() => '');
}

async function userPromptVisible(page, config, prompt) {
  const normalize = (value) => String(value ?? '').replace(/\s+/gu, '').trim();
  const expected = normalize(prompt);
  const matchesPrompt = (value) => {
    const actual = normalize(value);
    return (
      actual === expected ||
      (expected.length >= 40 && actual.includes(expected.slice(0, Math.min(160, expected.length))) && actual.length <= expected.length + 240)
    );
  };

  const exactText = page.getByText(prompt, { exact: true });
  const exactCount = await exactText.count().catch(() => 0);
  for (let index = exactCount - 1; index >= Math.max(0, exactCount - 10); index -= 1) {
    if (await isVisible(exactText.nth(index))) {
      return true;
    }
  }

  const selectors = mergeSelectors(config.userMessageSelector, [
    "[data-message-author-role='user']",
    "[data-role='user']",
    "[data-testid*='user-message' i]",
    "[class*='user-message' i]",
    "[class*='message-user' i]",
    "[class*='human-message' i]",
  ]);
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = count - 1; index >= Math.max(0, count - 20); index -= 1) {
      const candidate = locator.nth(index);
      if (!(await isVisible(candidate))) {
        continue;
      }
      const text = await candidate.textContent().catch(() => '');
      if (matchesPrompt(text)) {
        return true;
      }
    }
  }
  return false;
}

async function clickLikelySendButton(inputLocator) {
  return inputLocator.evaluate((input) => {
    const inputRect = input.getBoundingClientRect();
    const sendWords = /send|submit|\u53d1\u9001|\u63d0\u4ea4/iu;
    const toolWords = /\u5feb\u901f|\u7f16\u7a0b|\u56fe\u50cf|ppt|\u7ffb\u8bd1|\u89c6\u9891|\u66f4\u591a|\u6dfb\u52a0|\u4e0a\u4f20|new chat|new conversation/iu;

    const colorLooksSend = (value) => {
      const match = String(value).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/iu);
      if (!match) {
        return false;
      }
      const red = Number(match[1]);
      const green = Number(match[2]);
      const blue = Number(match[3]);
      return blue >= 140 && blue > red + 25 && blue >= green;
    };

    const isVisible = (element, rect) => {
      const style = window.getComputedStyle(element);
      return (
        rect.width >= 18 &&
        rect.height >= 18 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity || 1) > 0.05
      );
    };

    const isDisabled = (element) =>
      element.disabled ||
      element.getAttribute('aria-disabled') === 'true' ||
      /\bdisabled\b/iu.test(element.className?.toString() ?? '');

    const textFor = (element) =>
      [
        element.textContent,
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('data-testid'),
        element.className?.toString(),
      ]
        .filter(Boolean)
        .join(' ')
        .trim();

    let scope = input.closest('form') ?? input.parentElement;
    for (let depth = 0; scope?.parentElement && depth < 6; depth += 1) {
      const rect = scope.getBoundingClientRect();
      if (rect.width >= inputRect.width * 0.8 && scope.querySelector('button,[role="button"]')) {
        break;
      }
      scope = scope.parentElement;
    }

    const candidates = Array.from((scope ?? document).querySelectorAll('button,[role="button"]'));
    let best = null;

    for (const element of candidates) {
      const rect = element.getBoundingClientRect();
      if (!isVisible(element, rect) || isDisabled(element)) {
        continue;
      }

      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const nearInputY = centerY >= inputRect.top - 30 && centerY <= inputRect.bottom + 110;
      const rightHalf = centerX >= inputRect.left + inputRect.width * 0.5;
      if (!nearInputY || !rightHalf) {
        continue;
      }

      const text = textFor(element);
      let score = 0;
      if (sendWords.test(text)) {
        score += 100;
      }
      if (toolWords.test(text)) {
        score -= 100;
      }

      const style = window.getComputedStyle(element);
      if (
        colorLooksSend(style.backgroundColor) ||
        colorLooksSend(style.color) ||
        colorLooksSend(style.borderColor) ||
        Array.from(element.querySelectorAll('svg, path, use')).some((node) => {
          const nodeStyle = window.getComputedStyle(node);
          return colorLooksSend(nodeStyle.fill) || colorLooksSend(nodeStyle.stroke);
        })
      ) {
        score += 65;
      }

      if (centerX >= inputRect.left + inputRect.width * 0.78) {
        score += 50;
      }
      if (rect.width <= 90 && rect.height <= 90) {
        score += 20;
      }
      if (/arrow-up|send-button|icon-send/iu.test(text)) {
        score += 80;
      }

      if (!best || score > best.score) {
        best = { element, score };
      }
    }

    if (!best || best.score < 55) {
      return false;
    }

    best.element.click();
    return true;
  });
}

function textLooksIntermediate(text) {
  const compact = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (!compact) {
    return true;
  }
  const shortText = compact.length <= 900;

  return (
    /^(?:\u6b63\u5728)?\u641c\u7d22(?:\u7f51\u9875|\u7f51\u7edc)?/iu.test(compact) ||
    /^(?:\u6b63\u5728)?(?:\u601d\u8003|\u601d\u8003\u4e2d|\u63a8\u7406|\u751f\u6210|\u68c0\u7d22|\u67e5\u8be2)/iu.test(compact) ||
    /^Searching\b/iu.test(compact) ||
    /^Thinking\b/iu.test(compact) ||
    /^(?:still\s+|currently\s+|now\s+)?(?:searching|thinking|reasoning|reading|fetching)\b.{0,220}$/iu.test(compact) ||
    (shortText && /\u641c\u7d22\u7f51\u9875.{0,220}\d+\s*\u4e2a\u7ed3\u679c/iu.test(compact)) ||
    (shortText && /(?:\u627e\u5230|\u641c\u7d22\u5230)\s*\d+\s*(?:\u7bc7\u8d44\u6599|\u4e2a\u7f51\u9875|\u6761\u7ed3\u679c)/iu.test(compact)) ||
    (shortText && /(?:\u6d4f\u89c8|\u9605\u8bfb|\u83b7\u53d6)\s*\d+\s*(?:\u4e2a|\u7bc7)?(?:\u9875\u9762|\u7f51\u9875|\u8d44\u6599)/iu.test(compact)) ||
    /\u6b63\u5728(?:\u8054\u7f51)?\u641c\u7d22|\u6b63\u5728\u68c0\u7d22|\u6b63\u5728\u601d\u8003|\u6b63\u5728\u751f\u6210/iu.test(compact) ||
    (shortText && /(?:^|[\s|:：])\u7f51\u9875\u641c\u7d22(?:[\s|:：]|$)|\u641c\u7d22\u4e2d|\u601d\u8003\u4e2d|\u67e5\u8d44\u6599|\u627e\u8d44\u6599|\u83b7\u53d6\u7f51\u9875|\u6d4f\u89c8\u9875\u9762|\u6253\u5f00\u8fd9\u4e9b\u76f8\u5173\u7684\u94fe\u63a5/iu.test(compact)) ||
    /^.{0,180}\u7528\u6237(?:\u53ef\u80fd|\u4f3c\u4e4e|\u5e94\u8be5|\u662f\u60f3|\u8981\u627e|\u60f3\u627e).{0,520}(?:\u6211(?:\u8003\u8651|\u9700\u8981|\u5c06|\u4f1a)|\u5148|\u63a5\u4e0b\u6765).{0,260}(?:\u641c\u7d22|\u67e5\u627e|\u68c0\u7d22|\u6838\u5bf9|\u786e\u8ba4|\u6253\u5f00)/iu.test(compact) ||
    /^.{0,120}\u7528\u6237(?:\u9700\u8981|\u60f3\u8981).{0,260}\u6211\u9700\u8981.{0,260}(?:\u641c\u7d22|\u67e5\u627e|\u68c0\u7d22|\u6838\u5bf9|\u786e\u8ba4|\u63d0\u4f9b)/iu.test(compact) ||
    /^\u7528\u6237.{0,300}\u4e3a\u4e86.{0,120}(?:\u641c\u7d22|\u67e5\u627e|\u68c0\u7d22|\u5168\u9762\u8986\u76d6)/iu.test(compact) ||
    /^.{0,160}(?:\u6211\u9700\u8981|\u6211\u5c06|\u6211\u4f1a).{0,260}(?:\u641c\u7d22|\u67e5\u627e|\u68c0\u7d22|\u6d4f\u89c8|\u8bfb\u53d6|\u83b7\u53d6).{0,260}(?:\u8d44\u6599|\u9875\u9762|\u94fe\u63a5|\u7ed3\u679c)$/iu.test(compact) ||
    /^.{0,160}(?:\u8c46\u5305|\u65b0\u5bf9\u8bdd|Ctrl K|\u5386\u53f2\u5bf9\u8bdd).{0,800}(?:\u5feb\u901f|\u8d85\u80fd\u6a21\u5f0f|PPT \u751f\u6210|AI \u8868\u683c|\u56fe\u50cf\u751f\u6210|\u89c6\u9891\u751f\u6210)/iu.test(compact) ||
    /\u6b63\u5728\u641c\u7d22.{0,220}\u8df3\u8fc7$/iu.test(compact) ||
    /Kimi.{0,40}(?:\u7d2f|\u4eba\u592a\u591a)|\u9ad8\u5cf0\u671f\u7b97\u529b\u4e0d\u8db3|\u8bf7\u8010\u5fc3\u7b49\u5f85|\u665a\u70b9\u518d\u95ee|\u7533\u8bf7\u7e41\u5fd9|\u7cfb\u7edf\u7e41\u5fd9|\u8bf7\u6c42\u7e41\u5fd9|\u64cd\u4f5c\u9891\u7e41|\u7a0d\u540e\u518d\u8bd5|\u7f51\u7edc\u5f02\u5e38|\u751f\u6210\u5931\u8d25|too many requests|rate limit|try again/iu.test(compact) ||
    /^.{0,260}\u8df3\u8fc7$/iu.test(compact)
  );
}

export function textLooksModelRefusal(text) {
  const compact = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (!compact) {
    return false;
  }

  const shortTopicRedirect =
    compact.length <= 80 &&
    /^(?:尊敬的用户(?:您好|你好)?[，,、：:\s]*)?(?:让我们|我们)(?:换|聊)(?:一个|个)?(?:其他|别的|另外的|新)?话题(?:再)?(?:聊聊|聊|吧)(?:吧)?[。！？!?]*$/iu.test(
      compact,
    );

  return (
    shortTopicRedirect ||
    /(?:^|[。！？\s])(?:抱歉|很抱歉|对不起|不好意思)[，,、\s]*(?:我)?(?:暂时)?(?:无法|不能|不可以|没法)(?:回答|回应|帮助|协助|处理|满足|完成)(?:你|您|这个|该|此)?(?:的)?(?:问题|请求|内容|话题|需求)?/iu.test(compact) ||
    /(?:^|[。！？\s])(?:抱歉|很抱歉|对不起|不好意思)[，,、\s]*(?:我)?(?:暂时)?(?:无法|不能|不可以|没法)提供(?:你|您|这个|该|此)?(?:的)?(?:帮助|协助|请求|内容|答案|回答|相应信息)/iu.test(compact) ||
    /(?:针对|关于)?(?:这个|该|此)?(?:问题|请求|内容|话题)?(?:我)?(?:暂时)?(?:无法|不能|不可以|没法)为(?:你|您)提供(?:相应|相关|具体|这方面)?(?:的)?(?:解答|回答|帮助|协助|支持|信息|内容)/iu.test(compact) ||
    /(?:抱歉|很抱歉|对不起|不好意思).{0,100}(?:出于|基于).{0,100}(?:隐私|政策|规则|规范|安全).{0,120}(?:我)?(?:暂时)?(?:无法|不能|不可以|没法)(?:提供|回答|回应|帮助|协助)/iu.test(compact) ||
    /(?:我|本助手|该模型)(?:暂时)?(?:无法|不能|不可以|没法)(?:回答|回应|帮助|协助|处理|满足|完成)(?:你|您|这个|该|此)?(?:的)?(?:问题|请求|内容|话题|需求)/iu.test(compact) ||
    /(?:这个|该|此)(?:问题|请求|内容|话题|需求).{0,40}(?:无法|不能|不可以|没法)(?:回答|回应|处理|满足|完成)/iu.test(compact) ||
    /(?:抱歉|很抱歉|对不起|不好意思|无法回答|不能回答|无法提供帮助).{0,80}(?:违反|不符合|出于|基于).{0,80}(?:政策|规则|规范|安全要求|社区准则|安全原因|安全考虑)/iu.test(compact) ||
    /\b(?:sorry|apolog(?:y|ize)|i'?m sorry)\b.{0,160}\b(?:can(?:not|'t)|unable to|won't|not able to)\b.{0,160}\b(?:answer|help|assist|comply|provide|fulfill|continue|respond)\b/iu.test(compact) ||
    /\b(?:i|we)\s+(?:can(?:not|'t)|am unable to|are unable to|won't|cannot)\s+(?:answer|help|assist|comply|provide|fulfill|continue|respond)\b/iu.test(compact) ||
    /\b(?:sorry|apolog(?:y|ize)|i'?m sorry|unable to|cannot|can'?t)\b.{0,160}\b(?:against|violates?|breach(?:es)?)\s+(?:policy|policies|safety|guidelines|rules)\b/iu.test(compact)
  );
}

function normalizeStateText(text) {
  return String(text ?? '').replace(/\s+/gu, ' ').trim();
}

function textLooksThinking(text) {
  const compact = normalizeStateText(text);
  if (!compact) {
    return false;
  }
  return /正在思考|思考中|深度思考|推理中|正在推理|^(?:still\s+|currently\s+|now\s+)?(?:reasoning|thinking)\b|deepthink/iu.test(compact);
}

function textLooksSearching(text) {
  const compact = normalizeStateText(text);
  if (!compact) {
    return false;
  }
  const shortStatusText = compact.length <= 520;
  return (
    /正在(?:联网)?搜索|正在检索|正在查(?:找)?资料|正在获取|正在读取/iu.test(compact) ||
    /^(?:still\s+|currently\s+|now\s+)?(?:searching|browsing|retrieving|fetching)\b/iu.test(compact) ||
    (shortStatusText &&
      /搜索中|搜索网页|检索中|查资料|找资料|找到\s*\d+\s*(?:篇资料|个网页|条结果)|(?:浏览|阅读|获取)\s*\d+\s*(?:个|篇)?(?:页面|网页|资料)/iu.test(compact))
  );
}

function textLooksToolCalling(text) {
  const compact = normalizeStateText(text);
  if (!compact) {
    return false;
  }
  return /正在(?:调用|使用|运行).{0,24}(?:工具|插件|浏览器|网页|代码|函数)|工具调用中|任务助理|调用工具|^(?:running|using)\s+(?:a\s+)?tool\b|tool call|function call/iu.test(compact);
}

function stateSignalText(text, maxChars = 700) {
  const compact = normalizeStateText(text);
  return compact.length <= maxChars ? compact : compact.slice(-maxChars);
}

export function textLooksWaitingPermission(text) {
  const compact = stateSignalText(text);
  if (!compact) {
    return false;
  }
  return /(?:需要|等待|请).{0,24}(?:授权|允许|授予权限|访问权限)|(?:请|需要|等待).{0,24}(?:确认|同意).{0,24}(?:授权|权限|访问|继续使用|工具调用)|权限不足|无法访问该工具|请先登录|\b(?:authorization|permission)\s+(?:is\s+)?required\b|\bplease\s+(?:authorize|grant permission|allow access)\b|\bgrant permission\b/iu.test(compact);
}

function textLooksToolLimit(text) {
  const compact = stateSignalText(text);
  if (!compact) {
    return false;
  }
  return /(?:工具|插件|联网搜索|浏览器).{0,40}(?:不可用|无法使用|权限不足|受限|限制|开通|升级|额度不足)|tool unavailable|tool limit|tool access|upgrade to use/iu.test(compact);
}

function textLooksNetworkError(text) {
  const compact = stateSignalText(text);
  if (!compact) {
    return false;
  }
  return /网络(?:异常|错误|连接失败|超时)|连接(?:失败|超时)|请求超时|无法连接|network error|connection failed|timed out|timeout/iu.test(compact);
}

export function textLooksServiceIssue(text) {
  const compact = stateSignalText(text);
  if (!compact) {
    return false;
  }
  return /服务(?:异常|繁忙|不可用|超时|出错)|系统(?:繁忙|错误|异常|出错)|请求(?:繁忙|异常|失败|超时)|申请繁忙|高峰期算力不足|稍后再试|晚点再问|生成(?:失败|异常|出错)|出错了|发生错误|页面异常|请重试|开小差|too many requests|rate limit|service unavailable|server error|system error|request failed|something went wrong|failed to generate|(?:server|service|system|we(?:'re| are))\s+(?:is\s+)?busy|too busy|try again later|please retry/iu.test(compact);
}

function textLooksGenerationInterrupted(text) {
  const compact = stateSignalText(text);
  if (!compact) {
    return false;
  }
  return /回答中断|生成中断|流式中断|重新生成|再试一次|点击重试|请求失败|continue generating|regenerate|try again|retry/iu.test(compact);
}

function textLooksLikePromptEcho(text, prompt = '') {
  const compactText = String(text ?? '').replace(/\s+/gu, '');
  const compactPrompt = String(prompt ?? '').replace(/\s+/gu, '');
  if (!compactText || compactPrompt.length < 20) {
    return false;
  }

  return compactText === compactPrompt || (compactText.includes(compactPrompt.slice(0, Math.min(80, compactPrompt.length))) && compactText.length <= compactPrompt.length + 120);
}

export function textLooksPageChrome(text) {
  const compact = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (!compact) {
    return false;
  }

  const suggestionStarts =
    compact.match(
      /(?:^|\s)(?:资讯：|热点：|如何|怎样|为什么|帮我|教我|指导我|解释|分析|请推荐|列出|设计|给出|总结|找出|有哪些|科普一下)/gu,
    ) ?? [];
  const looksLikeSuggestionList = compact.length <= 500 && suggestionStarts.length >= 6;

  return (
    looksLikeSuggestionList ||
    /^(?:有什么我能帮你的吗？?|你在忙什么[？?]?|使用快速模式开始对话)/u.test(compact) ||
    /^(?:开启新对话|新建对话|新建会话).{0,180}(?:今天|昨天|历史对话|最近对话|我的空间)/su.test(compact) ||
    /^Gemini\s*(?:发起新对话|新对话)/iu.test(compact) ||
    /^新建会话\s*(?:Ctrl\s*K|PPT|文档|深度研究)/iu.test(compact)
  );
}

export function textLooksInternalProcess(text) {
  const compact = String(text ?? '').replace(/\s+/gu, ' ').trim();
  const opening = compact.slice(0, 2600);
  const planning =
    /\bThe user (?:is asking|wants|asks)\b|\bWe need(?: to)?\b|\bI need to (?:search|find|verify|look)|\bLet me (?:search|look|try|check)|\bI'll search\b/iu.test(
      opening,
    );
  const toolTrace = /搜索网页|获取网页|\d+\s*个结果/u.test(opening);
  return planning || toolTrace;
}

export function textLooksInternalProcessOnly(text) {
  const compact = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (!textLooksInternalProcess(compact)) {
    return false;
  }

  const toolMarker = /(?:\u641c\u7d22\u7f51\u9875|\u83b7\u53d6\u7f51\u9875|\u6b63\u5728\u83b7\u53d6\u7f51\u9875(?:\.\.\.)?|\d+\s*\u4e2a(?:\u7ed3\u679c|\u7f51\u9875))/gu;
  let marker = null;
  let match;
  while ((match = toolMarker.exec(compact))) {
    marker = { end: toolMarker.lastIndex };
  }

  const finalPart = marker ? compact.slice(marker.end).trim() : '';
  const hasFinalAfterTools =
    finalPart.length >= 350 &&
    (/(?:\u5f15\u7528)\s*$/u.test(compact) ||
      /\u6839\u636e|\u57fa\u4e8e|\u603b\u7ed3|\u7ed3\u8bba|\u6838\u5bf9|\u786e\u8ba4|\u5b98\u65b9|\u6743\u5a01|Based on|Summary|Conclusion|Verification|What I (?:found|can)|Authoritative/iu.test(finalPart));
  const hasLongCitedFinal = compact.length >= 700 && /(?:\u5f15\u7528)\s*$/u.test(compact);

  return !hasFinalAfterTools && !hasLongCitedFinal;
}

function textLooksConversationContainer(text, prompt = '') {
  const compact = String(text ?? '').replace(/\s+/gu, '').trim();
  const compactPrompt = String(prompt ?? '').replace(/\s+/gu, '').trim();
  if (compactPrompt.length < 40) {
    return false;
  }

  const needle = compactPrompt.slice(0, Math.min(140, compactPrompt.length));
  let occurrences = 0;
  let offset = 0;
  while ((offset = compact.indexOf(needle, offset)) >= 0) {
    occurrences += 1;
    offset += needle.length;
    if (occurrences >= 2) {
      break;
    }
  }
  return occurrences >= 2 && /编辑|复制|分享|重新生成|换个话题|尊敬的用户/u.test(compact);
}

function scoreAnswerText(text, prompt = '') {
  const compact = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (!compact) {
    return -100000;
  }

  if (
    textLooksLikePromptEcho(compact, prompt) ||
    textLooksPageChrome(compact) ||
    textLooksConversationContainer(compact, prompt) ||
    /sourceMappingURL|<style\b|\.css\.map\b/iu.test(compact)
  ) {
    return -100000;
  }

  let score = Math.min(compact.length, 5000);
  if (compact.length < 80) {
    score -= (80 - compact.length) * 50;
  }
  if (textLooksIntermediate(compact)) {
    score -= 6000;
  }
  if (textLooksInternalProcess(compact)) {
    score -= 9000;
  }
  if (prompt && compact.includes(prompt.slice(0, Math.min(60, prompt.length)))) {
    score -= compact.length <= prompt.length + 300 ? 5000 : 1200;
  }
  if (/https?:\/\/|www\./iu.test(compact)) {
    score += 400;
  }
  return score;
}

async function fallbackVisibleAnswerCandidate(page, config, prompt = '') {
  const minTextChars = Math.min(Math.max(config.minAnswerChars ?? 80, 40), 140);
  const fallback = await page
    .evaluate(
      ({ prompt: promptValue, minTextChars: minChars }) => {
        const normalize = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
        const compactPrompt = normalize(promptValue).replace(/\s+/gu, '');
        const cssEscape = (value) => window.CSS?.escape?.(value) ?? String(value).replace(/["\\#.:,[\]()>+~*^$|= ]/gu, '\\$&');
        const textLooksLikePromptEcho = (text) => {
          const compactText = normalize(text).replace(/\s+/gu, '');
          if (!compactText || compactPrompt.length < 20) {
            return false;
          }
          return (
            compactText === compactPrompt ||
            (compactText.includes(compactPrompt.slice(0, Math.min(80, compactPrompt.length))) &&
              compactText.length <= compactPrompt.length + 120)
          );
        };
        const textLooksPageChrome = (text) => {
          const compact = normalize(text);
          return (
            /^(?:有什么我能帮你的吗？?|你在忙什么[？?]?|使用快速模式开始对话)/u.test(compact) ||
            /^(?:开启新对话|新建对话|新建会话).{0,180}(?:今天|昨天|历史对话|最近对话|我的空间)/su.test(compact) ||
            /^Gemini\s*(?:发起新对话|新对话)/iu.test(compact) ||
            /^新建会话\s*(?:Ctrl\s*K|PPT|文档|深度研究)/iu.test(compact)
          );
        };
        const selectorFor = (element) => {
          if (element.id) {
            const idSelector = `#${cssEscape(element.id)}`;
            if (document.querySelectorAll(idSelector).length === 1) {
              return idSelector;
            }
          }

          const parts = [];
          let current = element;
          while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
            const tag = current.tagName.toLowerCase();
            const siblings = Array.from(current.parentElement?.children ?? []).filter(
              (sibling) => sibling.tagName === current.tagName,
            );
            const nth = siblings.indexOf(current) + 1;
            parts.unshift(`${tag}:nth-of-type(${nth})`);
            current = current.parentElement;
          }
          return parts.length > 0 ? `body > ${parts.join(' > ')}` : 'body';
        };
        const elementVisible = (element, rect) => {
          const style = window.getComputedStyle(element);
          return (
            rect.width >= 80 &&
            rect.height >= 18 &&
            rect.bottom >= 70 &&
            rect.top <= window.innerHeight + 120 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            Number(style.opacity || 1) > 0.05
          );
        };
        const rejectText = /\b(?:new chat|history|workspace|agent|ppt|login|download|share)\b|新建对话|新会话|最近对话|历史对话|我的空间|智能体|向千问提问|任务助理|千问高考|PPT创作|PPT 生成|AI 表格|AI生视频|图像生成|视频生成|登录|下载|内容由.*AI 生成/iu;
        const rejectClass = /tooltip|toast|modal|popover|sidebar|history|source-card|citation|reference|input|composer|toolbar|menu|button|question|prompt|page|host|scroller|skill-bar|loading-container|flowing-light|dot-flashing/iu;
        const preferClass = /answer|assistant|markdown|message-select-wrapper-answer|chat-answers-card|answer-common-card|qk-markdown|response|model/iu;

        const selector =
          'main, article, section, [class*="answer"], [class*="markdown"], [class*="assistant"], [class*="response"], [class*="message"], [class*="chat"], [class*="content"], div, p, ol, ul';
        const elements = Array.from(document.querySelectorAll(selector));
        const viewportArea = Math.max(window.innerWidth * window.innerHeight, 1);
        let best = null;

        for (const element of elements) {
          const tag = element.tagName.toLowerCase();
          if (['script', 'style', 'svg', 'path', 'use', 'input', 'textarea', 'button', 'nav', 'aside', 'header', 'footer'].includes(tag)) {
            continue;
          }
          if (element.closest('nav,aside,header,footer,textarea,input,button,[role="textbox"],[contenteditable="true"]')) {
            continue;
          }

          const className = element.className?.toString() ?? '';
          const rect = element.getBoundingClientRect();
          if (!elementVisible(element, rect)) {
            continue;
          }

          const text = normalize(element.innerText);
          if (text.length < minChars || textLooksLikePromptEcho(text) || textLooksPageChrome(text)) {
            continue;
          }

          let score = Math.min(text.length, 5000);
          if (preferClass.test(className)) {
            score += 9000;
          }
          if (rejectClass.test(className) || rejectText.test(text.slice(0, 500))) {
            score -= 9000;
          }
          if (window.innerWidth >= 900 && rect.left < Math.min(260, window.innerWidth * 0.16)) {
            score -= 2500;
          }
          if (rect.top < 90 && rect.height < 120) {
            score -= 1500;
          }
          const areaRatio = (rect.width * rect.height) / viewportArea;
          if (areaRatio > 0.72) {
            score -= 5000;
          }
          if (element.querySelector('a[href]')) {
            score += 300;
          }
          if (text.includes('http://') || text.includes('https://') || text.includes('www.')) {
            score += 300;
          }

          if (!best || score > best.score) {
            best = { selector: selectorFor(element), rawText: text, score };
          }
        }

        return best;
      },
      { prompt, minTextChars },
    )
    .catch(() => null);

  if (!fallback?.selector || !fallback.rawText || textLooksPageChrome(fallback.rawText)) {
    return null;
  }

  const fallbackAnswerScore = scoreAnswerText(fallback.rawText, prompt);
  if (fallbackAnswerScore <= -100000) {
    return null;
  }

  return {
    locator: page.locator(fallback.selector).first(),
    selector: fallback.selector,
    index: 0,
    rawText: fallback.rawText,
    score: fallbackAnswerScore + Math.max(fallback.score, 0) / 100,
  };
}

async function candidateAnswerLocators(page, config) {
  const selectors = mergeSelectors(config.assistantMessageSelector, [
    "[data-message-author-role='assistant']",
    "[data-role='assistant']",
    "[data-message-id] [class*='md-box-root']",
    "[data-message-id] [data-render-engine='node']",
    "[class*='model-response']",
    "[class*='response-content']",
    "[class*='assistant']",
    "[class*='markdown']",
    ".markdown",
  ]);
  const candidates = [];
  for (let selectorIndex = 0; selectorIndex < selectors.length; selectorIndex += 1) {
    const selector = selectors[selectorIndex];
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    const start = Math.max(0, count - 30);
    for (let index = count - 1; index >= start; index -= 1) {
      candidates.push({
        locator: locator.nth(index),
        selector,
        index,
        selectorPriority: (selectors.length - selectorIndex) * 1000,
      });
    }
  }
  return candidates;
}

export async function extractLatestAssistantResponse(page, config, { prompt = '' } = {}) {
  const candidates = await candidateAnswerLocators(page, config);
  let best = null;

  for (const candidate of candidates) {
    if (!(await isVisible(candidate.locator))) {
      continue;
    }

    const insidePageChrome = await candidate.locator
      .evaluate((element) =>
        Boolean(
          element.closest(
            '#experiment-guidance-suggestions,[data-testid*="suggestion" i],[class*="guidance-suggestion" i]',
          ),
        ),
      )
      .catch(() => false);
    if (insidePageChrome) {
      continue;
    }

    const rawText =
      (await candidate.locator.innerText().catch(async () => candidate.locator.textContent().catch(() => '')))?.trim() ?? '';
    const answerScore = scoreAnswerText(rawText, prompt);
    if (answerScore <= -100000) {
      continue;
    }
    const score = answerScore + candidate.selectorPriority;
    if (!best || score > best.score) {
      best = { ...candidate, rawText, score };
    }
  }

  const fallback = await fallbackVisibleAnswerCandidate(page, config, prompt);
  if (fallback && (!best || fallback.score > best.score)) {
    best = fallback;
  }

  if (!best) {
    throw new AutomationError('page_structure_changed', 'Cannot find assistant message area');
  }

  const links = await best.locator.evaluate((element) =>
    Array.from(element.querySelectorAll('a[href]')).map((anchor) => ({
      href: anchor.href,
      text: anchor.textContent?.trim() ?? '',
    })),
  ).catch(() => []);

  const sameConversationRetryPolicy = resolveSameConversationRetryPolicy(config);
  const normalizedAnswerText = normalizeRetryMatchText(best.rawText);
  const matchesConfiguredRetryRefusal = Boolean(
    sameConversationRetryPolicy &&
      normalizedAnswerText &&
      sameConversationRetryPolicy.matchTexts.some((matchText) => normalizedAnswerText.includes(matchText)),
  );

  return {
    locator: best.locator,
    rawText: best.rawText,
    links,
    isIntermediate:
      textLooksIntermediate(best.rawText) ||
      textLooksLikePromptEcho(best.rawText, prompt) ||
      textLooksPageChrome(best.rawText) ||
      textLooksConversationContainer(best.rawText, prompt) ||
      textLooksInternalProcessOnly(best.rawText),
    isRefusal: textLooksModelRefusal(best.rawText) || matchesConfiguredRetryRefusal,
  };
}

function answerHasEnoughContent(response, config) {
  const minAnswerChars = config.minAnswerChars ?? 80;
  return String(response?.rawText ?? '').trim().length >= minAnswerChars && !response?.isIntermediate && !response?.isRefusal;
}

async function configuredStateSelectorVisible(page, config, keys) {
  const selectors = keys.flatMap((key) => [
    ...asArray(config.stateSelectors?.[key]),
    ...asArray(config.streamingDone?.[key]),
  ]);
  return findVisibleSelector(page, selectors);
}

async function answerActionButtonsVisible(page, config, answerLocator) {
  const configuredSelectors = [
    ...asArray(config.streamingDone?.answerActionSelectors),
    ...asArray(config.stateSelectors?.answerActionSelectors),
  ];
  if (await findVisibleSelector(page, configuredSelectors)) {
    return true;
  }

  if (config.streamingDone?.detectLikelyAnswerActionButtons === false || !answerLocator) {
    return false;
  }

  return answerLocator
    .evaluate((answerElement) => {
      const visible = (element, rect) => {
        const style = window.getComputedStyle(element);
        return (
          rect.width >= 8 &&
          rect.height >= 8 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          Number(style.opacity || 1) > 0.05
        );
      };
      const textFor = (element) =>
        [
          element.textContent,
          element.getAttribute?.('aria-label'),
          element.getAttribute?.('title'),
          element.getAttribute?.('data-testid'),
          element.id,
          element.className?.toString(),
          Array.from(element.querySelectorAll('svg,use,path'))
            .map((node) =>
              [
                node.getAttribute?.('aria-label'),
                node.getAttribute?.('class'),
                node.getAttribute?.('href'),
                node.getAttribute?.('xlink:href'),
                node.getAttribute?.('d'),
              ]
                .filter(Boolean)
                .join(' '),
            )
            .join(' '),
        ]
          .filter(Boolean)
          .join(' ');
      const actionWords =
        /copy|copied|clipboard|like|dislike|thumb|regenerate|retry|refresh|share|复制|拷贝|点赞|赞|点踩|踩|重新生成|重试|刷新|分享|引用/iu;
      const ignoreWords = /source|citation|网页|资料|http|https|download|下载|登录|新对话|历史/iu;
      const answerRect = answerElement.getBoundingClientRect();
      const roots = [];
      let current = answerElement;
      for (let depth = 0; current && depth < 6; depth += 1) {
        roots.push(current);
        current = current.parentElement;
      }

      const candidates = [];
      for (const root of roots) {
        candidates.push(
          ...root.querySelectorAll(
            'button,[role="button"],a[aria-label],a[title],[tabindex],svg,[class*="copy"],[class*="like"],[class*="thumb"],[class*="regen"],[class*="share"]',
          ),
        );
      }
      candidates.push(
        ...document.querySelectorAll(
          'button,[role="button"],a[aria-label],a[title],[tabindex],svg,[class*="copy"],[class*="like"],[class*="thumb"],[class*="regen"],[class*="share"],[class*="feedback"],[class*="operate"],[class*="action"]',
        ),
      );

      let matchedTextButtons = 0;
      let smallIconButtons = 0;
      const seen = new Set();
      for (const rawCandidate of candidates) {
        const candidate =
          rawCandidate.closest?.('button,[role="button"],a,[tabindex]') ?? rawCandidate.parentElement ?? rawCandidate;
        if (!candidate || seen.has(candidate)) {
          continue;
        }
        seen.add(candidate);

        const rect = candidate.getBoundingClientRect();
        if (!visible(candidate, rect)) {
          continue;
        }

        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const nearAnswerBottom =
          centerY >= answerRect.bottom - 60 &&
          centerY <= answerRect.bottom + 420 &&
          centerX >= answerRect.left - 80 &&
          centerX <= answerRect.right + 260;
        if (!nearAnswerBottom) {
          continue;
        }

        const text = textFor(candidate);
        if (ignoreWords.test(text) && !actionWords.test(text)) {
          continue;
        }
        if (actionWords.test(text)) {
          matchedTextButtons += 1;
        }

        const iconLike =
          rect.width <= 72 &&
          rect.height <= 72 &&
          (candidate.querySelector('svg,path,use') || rawCandidate.tagName?.toLowerCase() === 'svg');
        if (iconLike) {
          smallIconButtons += 1;
        }
      }

      return matchedTextButtons >= 1 || smallIconButtons >= 2;
    })
    .catch(() => false);
}

function manualReviewSignalFor(response, signals = {}) {
  const text = response?.rawText ?? '';
  if (signals.permission || textLooksWaitingPermission(text)) {
    return { state: 'waiting_user_authorization', errorType: 'permission_required' };
  }
  if (signals.toolLimited || textLooksToolLimit(text)) {
    return { state: 'tool_limited', errorType: 'tool_unavailable' };
  }
  if (signals.networkError || textLooksNetworkError(text)) {
    return { state: 'network_error', errorType: 'network_error' };
  }
  if (signals.serviceIssue || textLooksServiceIssue(text)) {
    return { state: 'service_issue', errorType: 'service_unavailable' };
  }
  if (signals.interruption || textLooksGenerationInterrupted(text)) {
    return { state: 'abnormal_interruption', errorType: 'generation_interrupted' };
  }
  return null;
}

async function observeAnswerState(page, config, response, context) {
  const now = Date.now();
  const text = response?.rawText ?? '';
  const platformIssue = await pagePlatformIssueSignal(page, config);
  const stopVisible = await stopButtonVisible(page, config);
  const activityVisible = await activityIndicatorVisible(page, config);
  const composerReady = await composerReadyVisible(page, config);
  const answerActionsVisible = await answerActionButtonsVisible(page, config, response?.locator);
  const thinkingSelector = await configuredStateSelectorVisible(page, config, [
    'thinkingSelector',
    'thinkingSelectors',
  ]);
  const searchingSelector = await configuredStateSelectorVisible(page, config, [
    'searchingSelector',
    'searchingSelectors',
    'searchSelector',
    'searchSelectors',
  ]);
  const toolSelector = await configuredStateSelectorVisible(page, config, [
    'toolCallingSelector',
    'toolCallingSelectors',
    'toolSelector',
    'toolSelectors',
  ]);
  const permissionSelector = await configuredStateSelectorVisible(page, config, [
    'permissionSelector',
    'permissionSelectors',
    'authorizationSelector',
    'authorizationSelectors',
  ]);
  const toolLimitSelector = await configuredStateSelectorVisible(page, config, [
    'toolLimitSelector',
    'toolLimitSelectors',
    'toolLimitedSelector',
    'toolLimitedSelectors',
  ]);
  const networkErrorSelector = await configuredStateSelectorVisible(page, config, [
    'networkErrorSelector',
    'networkErrorSelectors',
    'networkSelector',
    'networkSelectors',
  ]);
  const serviceIssueSelector = await configuredStateSelectorVisible(page, config, [
    'serviceIssueSelector',
    'serviceIssueSelectors',
    'serviceSelector',
    'serviceSelectors',
  ]);
  const interruptionSelector = await configuredStateSelectorVisible(page, config, [
    'interruptionSelector',
    'interruptionSelectors',
    'errorSelector',
    'errorSelectors',
  ]);

  const validContent = answerHasEnoughContent(response, config) && now - context.answerStartedAt >= context.minWaitAfterStartMs;
  const stableTextWithActionsMs =
    config.streamingDone?.stableTextWithActionButtonsMs ??
    config.streamingDone?.textStableWithActionButtonsMs ??
    config.streamingDone?.stableMs ??
    3000;
  const actionButtonsStable =
    config.streamingDone?.allowTextStableWithActionButtons === true &&
    validContent &&
    answerActionsVisible &&
    context.textStableMs >= stableTextWithActionsMs &&
    !response?.isIntermediate &&
    !response?.isRefusal;
  const stopButtonLooksStale =
    (config.streamingDone?.allowStaleStopButtonCompletion === true ||
      config.streamingDone?.maxStopButtonWaitAfterValidMs !== undefined) &&
    stopVisible &&
    context.validContentSince !== null &&
    context.maxStopButtonWaitAfterValidMs !== null &&
    now - context.validContentSince >= context.maxStopButtonWaitAfterValidMs;
  const requireComposerReady = config.streamingDone?.requireComposerReady !== false;
  const composerNotReady = requireComposerReady && composerReady === false && !stopButtonLooksStale;
  const thinking = Boolean(thinkingSelector) || textLooksThinking(text);
  const searching = Boolean(searchingSelector) || textLooksSearching(text);
  const toolCalling = Boolean(toolSelector) || textLooksToolCalling(text);
  const permission = Boolean(permissionSelector) || textLooksWaitingPermission(text);
  const interruption = Boolean(interruptionSelector) || textLooksGenerationInterrupted(text);
  const toolLimited = Boolean(toolLimitSelector) || textLooksToolLimit(text);
  const networkError = Boolean(networkErrorSelector) || textLooksNetworkError(text);
  const serviceIssue = Boolean(platformIssue) || Boolean(serviceIssueSelector) || textLooksServiceIssue(text);
  const refusalActiveGraceMs = Math.max(
    0,
    Number(config.streamingDone?.refusalActiveGraceMs ?? 6000) || 0,
  );
  const refusalHardGraceMs = Math.max(
    refusalActiveGraceMs,
    Number(config.streamingDone?.refusalHardGraceMs ?? 20000) || 0,
  );
  const refusalHasNoLiveWork =
    !thinking &&
    !searching &&
    !toolCalling &&
    !permission &&
    !toolLimited &&
    !networkError &&
    !serviceIssue &&
    !interruption;
  const refusalSignalsStale = Boolean(
    response?.isRefusal &&
      refusalHasNoLiveWork &&
      (context.textStableMs >= refusalHardGraceMs ||
        (context.textStableMs >= refusalActiveGraceMs &&
          (answerActionsVisible || composerReady === true || (!stopVisible && !activityVisible)))),
  );
  const staleActiveSignals =
    actionButtonsStable &&
    !thinking &&
    !toolCalling &&
    !permission &&
    !toolLimited &&
    !networkError &&
    !serviceIssue &&
    !interruption;
  const stillActive =
    !staleActiveSignals &&
    !refusalSignalsStale &&
    ((stopVisible && !stopButtonLooksStale) ||
      activityVisible ||
      composerNotReady ||
      thinking ||
      searching ||
      toolCalling);
  const textStableWithActionButtons =
    actionButtonsStable && staleActiveSignals;
  const manualReview =
    permission || toolLimited || networkError || serviceIssue || (interruption && !stillActive)
      ? manualReviewSignalFor(response, { permission, toolLimited, networkError, serviceIssue, interruption }) ?? {
          state: 'abnormal_interruption',
          errorType: 'generation_interrupted',
        }
      : null;

  let state = 'waiting_answer';
  if (manualReview) {
    state = manualReview.state;
  } else if (response?.isRefusal && !stillActive) {
    state = 'refusal';
  } else if (textStableWithActionButtons) {
    state = 'answer_candidate';
  } else if (toolCalling) {
    state = 'tool_calling';
  } else if (searching) {
    state = 'searching';
  } else if (thinking) {
    state = 'thinking';
  } else if (stillActive) {
    state = 'generating';
  } else if (validContent) {
    state = 'answer_candidate';
  }

  return {
    state,
    finalState: state,
    errorType: manualReview?.errorType ?? null,
    manualReviewRequired: Boolean(manualReview),
    textChars: String(text).length,
    validContent,
    completionEligible:
      (validContent && !stillActive && !manualReview && !response?.isRefusal) ||
      (textStableWithActionButtons && !manualReview),
    completionReason: textStableWithActionButtons ? 'text_stable_with_action_buttons' : 'state_machine_stable',
    refusalEligible: Boolean(response?.isRefusal && !stillActive && !manualReview),
    stillActive,
    stopVisible: Boolean(stopVisible && !stopButtonLooksStale),
    stopButtonLooksStale,
    activityVisible,
    staleActiveSignals,
    refusalSignalsStale,
    composerReady,
    answerActionsVisible,
    thinking,
    searching,
    toolCalling,
    waitingPermission: permission,
    toolLimited,
    networkError,
    serviceIssue,
    interruption,
    manualReviewAnswerOverride: platformIssue ? buildPlatformIssueAnswer(page, platformIssue) : null,
    isIntermediate: Boolean(response?.isIntermediate),
    isRefusal: Boolean(response?.isRefusal),
    selectors: {
      thinking: thinkingSelector,
      searching: searchingSelector,
      tool: toolSelector,
      permission: permissionSelector,
      toolLimit: toolLimitSelector,
      networkError: networkErrorSelector,
      serviceIssue: platformIssue?.selector ?? serviceIssueSelector,
      interruption: interruptionSelector,
    },
  };
}

function snapshotFromObservation(observation, { elapsedMs, stableMs, sinceStateMs }) {
  return {
    timestamp: new Date().toISOString(),
    elapsed_ms: elapsedMs,
    state: observation.state,
    error_type: observation.errorType,
    manual_review_required: observation.manualReviewRequired,
    text_chars: observation.textChars,
    stable_ms: stableMs,
    state_ms: sinceStateMs,
    completion_eligible: observation.completionEligible,
    refusal_eligible: observation.refusalEligible,
    active: observation.stillActive,
    stop_visible: observation.stopVisible,
    activity_visible: observation.activityVisible,
    stale_active_signals: observation.staleActiveSignals,
    refusal_signals_stale: observation.refusalSignalsStale,
    composer_ready: observation.composerReady,
    thinking: observation.thinking,
    searching: observation.searching,
    tool_calling: observation.toolCalling,
    waiting_permission: observation.waitingPermission,
    tool_limited: observation.toolLimited,
    network_error: observation.networkError,
    service_issue: observation.serviceIssue,
    interruption: observation.interruption,
    intermediate: observation.isIntermediate,
    refusal: observation.isRefusal,
    answer_actions_visible: observation.answerActionsVisible,
    completion_reason: observation.completionReason,
    selectors: observation.selectors,
  };
}

function pushStateSnapshot(trace, snapshot, { force = false, maxSnapshots = 160 } = {}) {
  const previous = trace.at(-1);
  const changed =
    !previous ||
    previous.state !== snapshot.state ||
    previous.text_chars !== snapshot.text_chars ||
    previous.active !== snapshot.active ||
    previous.composer_ready !== snapshot.composer_ready ||
    previous.error_type !== snapshot.error_type;
  if (force || changed) {
    trace.push(snapshot);
    if (trace.length > maxSnapshots) {
      trace.splice(0, trace.length - maxSnapshots);
    }
  }
}

function resolveSendKey(config) {
  const configured = config.sendKey ?? config.sendKeyFallback;
  if (configured === false || configured === null) {
    return null;
  }

  const text = String(configured).trim();
  return ['none', 'false', 'off', 'no', ''].includes(text.toLowerCase()) ? null : text;
}

async function submitPrompt(page, config, inputLocator) {
  const sendSelectors = mergeSelectors(config.sendButtonSelector, DEFAULT_SEND_BUTTON_SELECTORS);
  try {
    let sendLocator = null;
    const deadline = Date.now() + (config.sendButtonTimeoutMs ?? 6000);
    while (Date.now() < deadline) {
      const found = await firstVisibleLocator(page, sendSelectors, {
        timeoutMs: 750,
        label: 'send button',
      }).catch(() => null);
      if (found && (await found.locator.isEnabled().catch(() => true))) {
        sendLocator = found.locator;
        break;
      }
      await page.waitForTimeout(250);
    }
    if (!sendLocator) {
      throw new AutomationError('page_structure_changed', 'Cannot find enabled send button', {
        selector: sendSelectors.join(' | '),
      });
    }
    await sendLocator.click({ timeout: config.sendTimeoutMs ?? 20000 });
    return;
  } catch (error) {
    if (config.clickLikelySendButton !== false && (await clickLikelySendButton(inputLocator))) {
      await page.waitForTimeout(300);
      return;
    }

    const sendKey = resolveSendKey(config);
    if (sendKey) {
      await inputLocator.click();
      await page.keyboard.press(sendKey);
      return;
    }

    throw error;
  }
}

async function submitPromptWithConfirmation(
  page,
  config,
  inputLocator,
  prompt,
  { beforeCount = 0, beforeText = '' } = {},
) {
  const maxAttempts = Math.max(1, Number(config.sendConfirmation?.maxAttempts ?? 3) || 3);
  const timeoutMs = Math.max(500, Number(config.sendConfirmation?.timeoutMs ?? 5000) || 5000);
  const pollMs = Math.max(50, Number(config.sendConfirmation?.pollMs ?? 250) || 250);
  const normalize = (value) => String(value ?? '').replace(/\s+/gu, '').trim();
  const expectedInput = normalize(prompt);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await submitPrompt(page, config, inputLocator);
    const deadline = Date.now() + timeoutMs;
    let latestInput = await inputText(inputLocator);

    while (Date.now() < deadline) {
      if (await userPromptVisible(page, config, prompt)) {
        return { confirmed: true, reason: 'user_message_visible', attempts: attempt };
      }

      const active = await assistantLocatorWithCount(page, config.assistantMessageSelector);
      if (active && active.count > beforeCount) {
        return { confirmed: true, reason: 'assistant_node_added', attempts: attempt };
      }

      const response = await extractLatestAssistantResponse(page, config, { prompt }).catch(() => null);
      if (response) {
        const currentText = normalize(response.rawText);
        const previousText = normalize(beforeText);
        if (currentText && currentText !== previousText) {
          return { confirmed: true, reason: 'assistant_response_changed', attempts: attempt };
        }
      }

      if ((await stopButtonVisible(page, config)) || (await activityIndicatorVisible(page, config))) {
        return { confirmed: true, reason: 'generation_started', attempts: attempt };
      }

      latestInput = await inputText(inputLocator);
      await page.waitForTimeout(pollMs);
    }

    const inputStillContainsPrompt = normalize(latestInput) === expectedInput;
    if (!inputStillContainsPrompt) {
      console.warn(
        `[${config.name ?? 'platform'}] prompt left the composer but no message node is visible yet; continuing to wait without resending.`,
      );
      return { confirmed: false, reason: 'composer_cleared', attempts: attempt };
    }

    if (attempt < maxAttempts) {
      console.warn(
        `[${config.name ?? 'platform'}] prompt submission was not observed; retrying safely because the composer still contains the prompt (${attempt}/${maxAttempts}).`,
      );
    }
  }

  throw new AutomationError(
    'prompt_not_sent',
    `Prompt submission was not observed after ${maxAttempts} attempts; the prompt is still in the composer`,
  );
}

async function submitPromptAndCollectOnce(page, config, prompt, pauseForHuman = async () => {}) {
  await guardPlatformBlocks(page, config, pauseForHuman);

  const before = await assistantLocatorWithCount(page, config.assistantMessageSelector);
  const beforeCount = before?.count ?? 0;
  const beforeResponse = await extractLatestAssistantResponse(page, config, { prompt }).catch(() => null);
  const beforeText = beforeResponse?.rawText ?? '';
  const { locator: inputLocator } = await firstVisibleLocator(page, config.inputSelector, {
    timeoutMs: config.inputTimeoutMs ?? 20000,
    label: 'input box',
  });
  await setPromptValue(page, inputLocator, prompt);

  const submission = await submitPromptWithConfirmation(page, config, inputLocator, prompt, {
    beforeCount,
    beforeText,
  });
  if (config.sendConfirmation?.log !== false) {
    console.log(
      `[${config.name ?? 'platform'}] prompt submission: reason=${submission.reason}, attempts=${submission.attempts}`,
    );
  }

  const answerStart = await waitForAssistantStart(page, config, { beforeCount, beforeText, prompt }, pauseForHuman);
  if (answerStart?.platformIssue) {
    return buildPlatformIssueAnswer(page, answerStart.platformIssue);
  }

  const timeoutMs = config.streamingDone?.timeoutMs ?? 120000;
  const stableMs = config.streamingDone?.stableMs ?? 3000;
  const pollMs = config.streamingDone?.pollMs ?? 1000;
  const minWaitAfterStartMs = config.streamingDone?.minWaitAfterStartMs ?? config.minWaitAfterAnswerStartMs ?? 0;
  const maxStopButtonWaitAfterValidMs = config.streamingDone?.maxStopButtonWaitAfterValidMs ?? null;
  const progressLogMs = config.streamingDone?.progressLogMs ?? 0;
  const refusalStableMs = config.streamingDone?.refusalStableMs ?? Math.min(stableMs, 3000);
  const manualReviewStableMs = config.streamingDone?.manualReviewStableMs ?? 5000;
  const stateSnapshotLogMs = config.streamingDone?.stateSnapshotLogMs ?? progressLogMs;
  const maxStateSnapshots = config.streamingDone?.maxStateSnapshots ?? 160;
  let deadline = Date.now() + timeoutMs;
  const answerStartedAt = Date.now();
  let lastText = '';
  let stableSince = Date.now();
  let validSince = null;
  let validContentSince = null;
  let lastResponse = null;
  let lastProgressLogAt = 0;
  let lastSnapshotLogAt = 0;
  let lastState = 'inputting';
  let stateSince = Date.now();
  const stateTrace = [];

  while (true) {
    await guardPlatformBlocks(page, config, pauseForHuman);
    const response = await extractLatestAssistantResponse(page, config, { prompt }).catch((error) => {
      if (error instanceof AutomationError && error.errorType === 'page_structure_changed') {
        return null;
      }
      throw error;
    });
    if (!response) {
      await page.waitForTimeout(pollMs);
      if (Date.now() >= deadline) {
        if (config.pauseOnAnswerTimeout === false) {
          throw new AutomationError('answer_timeout', 'Assistant answer did not reach a complete state before timeout');
        }
        await pauseForHuman(
          '尚未检测到有效的 assistant 回答。请确认提示词已经发出，页面不是首页推荐区，并检查是否需要重试；处理后按 Enter，脚本会继续等待当前样本。',
        );
        await guardPlatformBlocks(page, config, pauseForHuman);
        deadline = Date.now() + timeoutMs;
      }
      continue;
    }
    const currentText = response.rawText;
    lastResponse = response;

    if (currentText !== lastText) {
      lastText = currentText;
      stableSince = Date.now();
      validSince = null;
      validContentSince = null;
    }

    const now = Date.now();
    const observation = await observeAnswerState(page, config, response, {
      answerStartedAt,
      minWaitAfterStartMs,
      validContentSince,
      maxStopButtonWaitAfterValidMs,
      textStableMs: now - stableSince,
    });
    if (observation.state !== lastState) {
      lastState = observation.state;
      stateSince = now;
    }

    if (observation.validContent && validContentSince === null) {
      validContentSince = now;
    }
    if (!observation.validContent) {
      validContentSince = null;
    }

    const snapshot = snapshotFromObservation(observation, {
      elapsedMs: now - answerStartedAt,
      stableMs: now - stableSince,
      sinceStateMs: now - stateSince,
    });
    const snapshotLogDue = stateSnapshotLogMs > 0 && now - lastSnapshotLogAt >= stateSnapshotLogMs;
    pushStateSnapshot(stateTrace, snapshot, { force: snapshotLogDue, maxSnapshots: maxStateSnapshots });
    if (snapshotLogDue) {
      lastSnapshotLogAt = now;
    }

    if (progressLogMs > 0 && now - lastProgressLogAt >= progressLogMs) {
      const composerStatus = observation.composerReady === null ? 'unknown' : observation.composerReady ? 'ready' : 'not_ready';
      console.log(
        `[${config.name ?? 'platform'}] state=${observation.state}, chars=${currentText.length}, intermediate=${response.isIntermediate}, refusal=${response.isRefusal}, active=${observation.stillActive}, composer=${composerStatus}, actions=${observation.answerActionsVisible}, stop=${observation.stopVisible}, activity=${observation.activityVisible}, stale=${observation.staleActiveSignals}, thinking=${observation.thinking}, searching=${observation.searching}, tool=${observation.toolCalling}, service=${observation.serviceIssue}, manual=${observation.manualReviewRequired}, completion=${observation.completionReason}, stable_ms=${now - stableSince}, state_ms=${now - stateSince}`,
      );
      lastProgressLogAt = now;
    }

    if (observation.completionEligible && validSince === null) {
      validSince = now;
    }
    if (!observation.completionEligible) {
      validSince = null;
    }

    const stableEnough = now - stableSince >= stableMs && validSince !== null && now - validSince >= stableMs;
    if (stableEnough) {
      return {
        ...response,
        timedOut: false,
        finalState: 'completed',
        completionReason: observation.completionReason,
        stateTrace,
        stateSummary: {
          final_state: 'completed',
          completion_reason: observation.completionReason,
          total_snapshots: stateTrace.length,
          last_snapshot: stateTrace.at(-1) ?? null,
        },
      };
    }

    if (observation.refusalEligible && now - stableSince >= refusalStableMs) {
      return {
        ...response,
        timedOut: false,
        errorType: 'model_refusal',
        finalState: 'refusal',
        completionReason: 'model_refusal',
        manualReviewRequired: true,
        stateTrace,
        stateSummary: {
          final_state: 'refusal',
          completion_reason: 'model_refusal',
          total_snapshots: stateTrace.length,
          last_snapshot: stateTrace.at(-1) ?? null,
        },
      };
    }

    if (observation.manualReviewRequired && now - stateSince >= manualReviewStableMs) {
      const reviewResponse = observation.manualReviewAnswerOverride ?? response;
      return {
        ...reviewResponse,
        timedOut: false,
        errorType: observation.errorType,
        finalState: observation.state,
        completionReason: observation.errorType,
        manualReviewRequired: true,
        stateTrace,
        stateSummary: {
          final_state: observation.state,
          completion_reason: observation.errorType,
          total_snapshots: stateTrace.length,
          last_snapshot: stateTrace.at(-1) ?? null,
        },
      };
    }

    await page.waitForTimeout(pollMs);

    if (Date.now() >= deadline) {
      if (config.pauseOnAnswerTimeout === false) {
        const timeoutResponse = lastResponse ?? (await extractLatestAssistantResponse(page, config, { prompt }).catch(() => null));
        throw new AutomationError('answer_timeout', 'Assistant answer did not reach a complete state before timeout', {
          answer: timeoutResponse,
        });
      }
      await pauseForHuman(
        `回答还没有达到完整状态。请在浏览器里确认是否仍在生成、搜索、调用工具、限流或需要点击重试；处理后按 Enter，脚本会继续等待这一条样本。`,
      );
      await guardPlatformBlocks(page, config, pauseForHuman);
      deadline = Date.now() + timeoutMs;
    }
  }
}

function normalizeRetryMatchText(value) {
  return String(value ?? '')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function resolveSameConversationRetryPolicy(config) {
  const policy = config.sameConversationRetry;
  if (!policy || policy.enabled === false) {
    return null;
  }

  const matchTexts = asArray(policy.matchTexts ?? policy.matchText)
    .map((value) => normalizeRetryMatchText(value))
    .filter(Boolean);
  const maxRetries = Number(policy.maxRetries ?? 0);
  if (matchTexts.length === 0 || !Number.isInteger(maxRetries) || maxRetries < 1) {
    return null;
  }

  return {
    matchTexts,
    maxRetries,
    retryDelayMs: Math.max(0, Number(policy.retryDelayMs ?? 1000) || 0),
  };
}

function isSameConversationRetryMatch(answer, policy) {
  if (!policy || answer?.errorType !== 'model_refusal') {
    return false;
  }

  const answerText = normalizeRetryMatchText(answer.rawText);
  return answerText.length > 0 && policy.matchTexts.some((matchText) => answerText.includes(matchText));
}

function withSameConversationRetryMetadata(answer, { retries, exhausted }) {
  const retryMetadata = {
    retries,
    exhausted,
  };
  return {
    ...answer,
    sameConversationRetry: retryMetadata,
    stateSummary: {
      ...(answer.stateSummary ?? {}),
      same_conversation_retry: retryMetadata,
    },
  };
}

export async function submitPromptAndCollect(page, config, prompt, pauseForHuman = async () => {}) {
  const retryPolicy = resolveSameConversationRetryPolicy(config);
  let retries = 0;

  while (true) {
    const answer = await submitPromptAndCollectOnce(page, config, prompt, pauseForHuman);
    if (!isSameConversationRetryMatch(answer, retryPolicy)) {
      return retries > 0 ? withSameConversationRetryMetadata(answer, { retries, exhausted: false }) : answer;
    }

    if (retries >= retryPolicy.maxRetries) {
      return withSameConversationRetryMetadata(answer, { retries, exhausted: true });
    }

    retries += 1;
    console.warn(
      `[${config.name ?? 'platform'}] received configured privacy refusal; resending the same prompt in the current conversation (${retries}/${retryPolicy.maxRetries}).`,
    );
    if (retryPolicy.retryDelayMs > 0) {
      await page.waitForTimeout(retryPolicy.retryDelayMs);
    }
  }
}
