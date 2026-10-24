import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrowserLaunchAttempts, buildLaunchOptions } from '../src/runner.js';
import {
  textLooksInternalProcess,
  textLooksInternalProcessOnly,
  textLooksModelRefusal,
  textLooksPageChrome,
  textLooksServiceIssue,
  textLooksWaitingPermission,
} from '../src/browserFlow.js';

test('buildBrowserLaunchAttempts can use bundled Playwright Chromium without a fallback', () => {
  assert.deepEqual(buildBrowserLaunchAttempts({ fallbackBrowserChannel: 'none', fallbackBrowserExecutable: 'none' }), [
    { label: 'playwright-chromium' },
  ]);
});

test('buildBrowserLaunchAttempts uses an explicitly configured fallback browser', () => {
  assert.deepEqual(buildBrowserLaunchAttempts({ browserChannel: 'chrome', fallbackBrowserChannel: 'msedge' }), [
    { channel: 'chrome', label: 'chrome' },
    { channel: 'msedge', label: 'msedge' },
  ]);
});

test('buildBrowserLaunchAttempts does not automatically switch browsers after an explicit primary channel', () => {
  assert.deepEqual(buildBrowserLaunchAttempts({ browserChannel: 'chrome', fallbackBrowserChannel: 'none' }), [
    { channel: 'chrome', label: 'chrome' },
  ]);
});

test('buildBrowserLaunchAttempts does not automatically switch browsers after an explicit executable', () => {
  assert.deepEqual(buildBrowserLaunchAttempts({ browserExecutable: 'browser-bin/primary' }), [
    { executablePath: 'browser-bin/primary', label: 'executable:browser-bin/primary' },
  ]);
});

test('buildBrowserLaunchAttempts prefers explicit executable paths when provided', () => {
  assert.deepEqual(
    buildBrowserLaunchAttempts({
      browserExecutable: 'browser-bin/primary',
      fallbackBrowserExecutable: 'browser-bin/fallback',
      fallbackBrowserChannel: 'none',
    }),
    [
      { executablePath: 'browser-bin/primary', label: 'executable:browser-bin/primary' },
      { executablePath: 'browser-bin/fallback', label: 'executable:browser-bin/fallback' },
    ],
  );
});

test('buildLaunchOptions can use the real browser window instead of a fixed viewport', () => {
  const { launchOptions, useWindowViewport } = buildLaunchOptions(
    {
      viewport: { width: 1600, height: 900 },
      windowSize: { width: 1920, height: 1030 },
      useWindowViewport: true,
      startMaximized: true,
    },
    { headless: false, slowMo: 0 },
    { executablePath: 'browser-bin/fallback' },
  );

  assert.equal(useWindowViewport, true);
  assert.equal(launchOptions.chromiumSandbox, true);
  assert.equal(launchOptions.viewport, null);
  assert.equal(launchOptions.screen, undefined);
  assert.equal(launchOptions.executablePath, 'browser-bin/fallback');
  assert.deepEqual(launchOptions.args, [
    '--window-size=1920,1030',
    '--window-position=0,0',
    '--force-device-scale-factor=1',
    '--start-maximized',
  ]);
});

test('buildLaunchOptions can explicitly disable Chromium sandbox for compatibility', () => {
  const { launchOptions } = buildLaunchOptions({}, { headless: false, slowMo: 0, chromiumSandbox: false }, {});
  assert.equal(launchOptions.chromiumSandbox, false);
});

test('page chrome and recommendation lists are never accepted as assistant answers', () => {
  assert.equal(
    textLooksPageChrome('有什么我能帮你的吗？ 如何学习 Python？ 资讯：今日热点 如何优化提示词？'),
    true,
  );
  assert.equal(
    textLooksPageChrome('开启新对话 今天 新对话 历史对话 测试记录 给 DeepSeek 发送消息'),
    true,
  );
  assert.equal(
    textLooksPageChrome(
      '资讯：今日热点 如何学习 Python？ 帮我设计课程 解释缓存机制 教我使用 GitHub 分析机器翻译 请推荐写作工具',
    ),
    true,
  );
  assert.equal(textLooksPageChrome('这是模型针对用户问题生成的完整回答，其中包含来源和结论。'), false);
});

test('internal planning and tool traces are penalized as intermediate process text', () => {
  assert.equal(textLooksInternalProcess("The user is asking for a source. Let me search for the official page."), true);
  assert.equal(textLooksInternalProcess('搜索网页 official source 27 个结果 Let me check another page.'), true);
  assert.equal(textLooksInternalProcess('这是最终回答，包含机构名称、来源和历史背景。'), false);
});

test('internal process is only accepted after a substantive final answer appears', () => {
  assert.equal(
    textLooksInternalProcessOnly('The user is asking for an official source. Let me search for the original page.'),
    true,
  );
  assert.equal(
    textLooksInternalProcessOnly(
      `The user is asking for an official source. \u641c\u7d22\u7f51\u9875 official source 20 \u4e2a\u7ed3\u679c Based on the official records, ${'the final answer provides the responsible authority and publication history. '.repeat(8)} \u5f15\u7528`,
    ),
    false,
  );
});

test('ordinary prose containing authorized or busy is not classified as a platform state', () => {
  const answer = `${'完整回答内容。'.repeat(120)} The organization was authorized in 2012 and served a busy port city.`;
  assert.equal(textLooksWaitingPermission(answer), false);
  assert.equal(textLooksServiceIssue(answer), false);
  assert.equal(textLooksWaitingPermission('Permission required. Please allow access to continue.'), true);
  assert.equal(textLooksServiceIssue('The server is busy. Please retry later.'), true);
});

test('explicit Chinese and English refusals are detected without treating source uncertainty as refusal', () => {
  assert.equal(textLooksModelRefusal('抱歉，我无法回答你的问题'), true);
  assert.equal(textLooksModelRefusal('很抱歉，出于隐私信息保护的考虑，我暂时无法提供相应信息。'), true);
  assert.equal(textLooksModelRefusal('尊敬的用户您好，让我们换个话题再聊聊吧。'), true);
  assert.equal(
    textLooksModelRefusal(
      '针对这个问题我无法为你提供相应解答。你可以尝试提供其他话题，我会尽力为你提供支持和解答。',
    ),
    true,
  );
  assert.equal(textLooksModelRefusal("Sorry, I can't continue to answer this request."), true);
  assert.equal(
    textLooksModelRefusal('完成这个资料核查后，如果你愿意，我们也可以换个话题再聊聊。'),
    false,
  );
  assert.equal(
    textLooksModelRefusal('我无法找到该报道的官方原文链接，但可以根据现有资料给出核查路径和后续验证建议。'),
    false,
  );
  assert.equal(
    textLooksModelRefusal('我可以为你提供相应解答，并列出官方来源和后续核查方法。'),
    false,
  );
});
