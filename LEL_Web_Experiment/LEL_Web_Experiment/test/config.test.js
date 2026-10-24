import test from 'node:test';
import assert from 'node:assert/strict';
import { listAvailablePlatforms, loadPlatformConfig } from '../src/config.js';

test('all platform configs can be loaded and include required selectors', async () => {
  const platforms = await listAvailablePlatforms('platforms');
  assert.deepEqual(platforms, ['chatgpt', 'deepseek', 'doubao', 'gemini', 'kimi', 'qwen']);

  for (const platform of platforms) {
    const config = await loadPlatformConfig(platform, 'platforms');
    assert.equal(config.name, platform);
    assert.ok(config.loginUrl);
    assert.ok(config.inputSelector);
    assert.ok(config.sendButtonSelector);
    assert.ok(config.assistantMessageSelector);
    assert.ok(config.newChat);
  }
});

test('web platforms enable action-button completion fallback for stale UI signals', async () => {
  for (const platform of await listAvailablePlatforms('platforms')) {
    const config = await loadPlatformConfig(platform, 'platforms');
    assert.equal(config.streamingDone?.allowTextStableWithActionButtons, true, platform);
    assert.ok(config.streamingDone?.answerActionSelectors?.length > 0, platform);
  }
});

test('Qwen uses clean primary and fallback chat URLs without advertising parameters', async () => {
  const config = await loadPlatformConfig('qwen', 'platforms');
  assert.equal(config.loginUrl, 'https://www.qianwen.com/chat');
  assert.deepEqual(config.fallbackLoginUrls, ['https://www.qianwen.com/']);
  assert.equal(config.newChat.actions[0].url, 'https://www.qianwen.com/chat');
  assert.deepEqual(config.newChat.actions[0].fallbackUrls, ['https://www.qianwen.com/']);
});

test('Kimi login checks avoid generic login-entry controls after the chat composer is ready', async () => {
  const config = await loadPlatformConfig('kimi', 'platforms');
  assert.equal(config.ignoreLoginExpiredWhenInputReady, true);
  assert.equal(config.loginExpiredSelectors.includes("button:has-text('登录')"), false);
  assert.equal(config.loginExpiredSelectors.some((selector) => selector.includes('手机号')), true);
});
