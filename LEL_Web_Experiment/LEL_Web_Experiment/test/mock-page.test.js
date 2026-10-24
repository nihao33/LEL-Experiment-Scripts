import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { guardPlatformBlocks, performNewChat, prepareChat, submitPromptAndCollect } from '../src/browserFlow.js';

function getSystemBrowserChannel() {
  return process.env.LEL_TEST_BROWSER_CHANNEL || null;
}

function startMockServer() {
  const html = `<!doctype html>
<html>
  <body>
    <button id="new-chat">New chat</button>
    <div id="messages"></div>
    <textarea id="prompt"></textarea>
    <button id="send">Send</button>
    <script>
      window.prompts = [];
      document.querySelector('#new-chat').addEventListener('click', () => {
        document.querySelector('#messages').innerHTML = '';
      });
      function sendPrompt() {
        const prompt = document.querySelector('#prompt').value;
        window.prompts.push(prompt);
        const message = document.createElement('div');
        message.className = 'assistant';
        message.innerHTML = 'Answer for ' + prompt + ' <a href="https://www.example.org/source">official</a>';
        document.querySelector('#messages').appendChild(message);
      }
      document.querySelector('#send').addEventListener('click', () => {
        sendPrompt();
      });
      document.querySelector('#prompt').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          sendPrompt();
        }
      });
    </script>
  </body>
</html>`;

  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test('mock chat page opens a new chat, submits prompt, and extracts answer', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const { server, url } = await startMockServer();
  const page = await browser.newPage();
  const config = {
    newChat: { actions: [{ type: 'click', selector: '#new-chat' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    minAnswerChars: 10,
    streamingDone: { timeoutMs: 5000, stableMs: 100, pollMs: 50 },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.goto(url);
    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Only send this prompt');

    assert.match(answer.rawText, /Answer for Only send this prompt/);
    assert.deepEqual(await page.evaluate(() => window.prompts), ['Only send this prompt']);
    assert.equal(answer.links[0].href, 'https://www.example.org/source');
  } finally {
    await page.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('mock chat page retries when the first send click has no effect and the prompt remains in the composer', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const html = `<!doctype html><html><body>
    <div id="messages"></div>
    <textarea id="prompt"></textarea>
    <button id="send">Send</button>
    <script>
      window.sendAttempts = 0;
      document.querySelector('#send').addEventListener('click', () => {
        window.sendAttempts += 1;
        if (window.sendAttempts < 2) return;
        const message = document.createElement('div');
        message.className = 'assistant';
        message.textContent = 'Confirmed answer after a safe retry with enough response text.';
        document.querySelector('#messages').appendChild(message);
      });
    </script>
  </body></html>`;
  const config = {
    name: 'mock',
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    minAnswerChars: 20,
    sendConfirmation: { maxAttempts: 2, timeoutMs: 250, pollMs: 25 },
    streamingDone: { timeoutMs: 3000, stableMs: 100, pollMs: 25 },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.goto(`data:text/html,${encodeURIComponent(html)}`);
    const answer = await submitPromptAndCollect(page, config, 'Retry this prompt exactly once');
    assert.match(answer.rawText, /Confirmed answer after a safe retry/);
    assert.equal(await page.evaluate(() => window.sendAttempts), 2);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page fails explicitly when the prompt never leaves the composer', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    name: 'mock',
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    sendConfirmation: { maxAttempts: 2, timeoutMs: 150, pollMs: 25 },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent('<textarea id="prompt"></textarea><button id="send">Send</button><div class="assistant"></div>');
    await assert.rejects(
      submitPromptAndCollect(page, config, 'This prompt must be observed before collection starts'),
      (error) => error?.errorType === 'prompt_not_sent',
    );
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page falls back to a configured URL when new-chat navigation is closed', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const fallbackUrl = `data:text/html,${encodeURIComponent('<textarea id="prompt"></textarea>')}`;
  const config = {
    newChat: {
      actions: [
        {
          type: 'goto',
          url: 'invalid-scheme://qwen-primary/chat',
          fallbackUrls: [fallbackUrl],
        },
      ],
    },
    inputSelector: '#prompt',
  };

  try {
    await performNewChat(page, config);

    assert.ok(page.url().startsWith('data:text/html,'));
    assert.equal(await page.locator('#prompt').count(), 1);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page can submit with sendKeyFallback when no send button is visible', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#missing-send-button',
    sendButtonTimeoutMs: 50,
    sendKeyFallback: 'Enter',
    assistantMessageSelector: '.assistant',
    minAnswerChars: 10,
    streamingDone: { timeoutMs: 5000, stableMs: 100, pollMs: 50 },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <div id="messages"></div>
      <script>
        window.prompts = [];
        document.querySelector('#prompt').addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            const prompt = event.target.value;
            window.prompts.push(prompt);
            const message = document.createElement('div');
            message.className = 'assistant';
            message.textContent = 'fallback answer for ' + prompt;
            document.querySelector('#messages').appendChild(message);
          }
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Fallback prompt');

    assert.equal(answer.rawText, 'fallback answer for Fallback prompt');
    assert.deepEqual(await page.evaluate(() => window.prompts), ['Fallback prompt']);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page can click an icon-only send button near the input', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#missing-send-button',
    sendButtonTimeoutMs: 50,
    sendKeyFallback: 'Enter',
    assistantMessageSelector: '.assistant',
    minAnswerChars: 10,
    streamingDone: { timeoutMs: 5000, stableMs: 100, pollMs: 50 },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <style>
        .composer { width: 900px; padding: 16px; border: 1px solid #aac8ff; border-radius: 24px; }
        #prompt { width: 100%; height: 64px; }
        .bar { display: flex; gap: 16px; align-items: center; }
        .arrow { margin-left: auto; width: 48px; height: 48px; border: 0; border-radius: 999px; background: rgb(0, 102, 255); color: white; }
      </style>
      <div class="composer">
        <textarea id="prompt"></textarea>
        <div class="bar">
          <button type="button">\u5feb\u901f</button>
          <button type="button">\u7f16\u7a0b</button>
          <button type="button">\u66f4\u591a</button>
          <button type="button" class="arrow">↑</button>
        </div>
      </div>
      <div id="messages"></div>
      <script>
        window.prompts = [];
        document.querySelector('.arrow').addEventListener('click', () => {
          const prompt = document.querySelector('#prompt').value;
          window.prompts.push(prompt);
          const message = document.createElement('div');
          message.className = 'assistant';
          message.textContent = 'icon answer for ' + prompt;
          document.querySelector('#messages').appendChild(message);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Icon prompt');

    assert.equal(answer.rawText, 'icon answer for Icon prompt');
    assert.deepEqual(await page.evaluate(() => window.prompts), ['Icon prompt']);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page ignores user prompt echo while waiting for assistant answer', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: ['.message-content', '.assistant'],
    minAnswerChars: 20,
    streamingDone: { timeoutMs: 5000, stableMs: 100, pollMs: 50, stopButtonSelectors: '#stop' },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">↑</button>
      <button id="stop" hidden>stop</button>
      <div id="messages"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const prompt = document.querySelector('#prompt').value;
          document.querySelector('#stop').hidden = false;
          const user = document.createElement('p');
          user.className = 'message-content';
          user.textContent = prompt;
          document.querySelector('#messages').appendChild(user);
          setTimeout(() => {
            const answer = document.createElement('div');
            answer.className = 'assistant';
            answer.textContent = 'This is the real assistant answer for the benchmark prompt with enough detail.';
            document.querySelector('#messages').appendChild(answer);
            document.querySelector('#stop').hidden = true;
          }, 250);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Prompt echo should not be the final answer');

    assert.equal(answer.rawText, 'This is the real assistant answer for the benchmark prompt with enough detail.');
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page retries Kimi-style busy response before collecting final answer', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    recoverableErrorSelectors: [
      'text=/\u521a\u521a\u548cKimi\u804a\u7684\u4eba\u592a\u591a|Kimi\u6709\u70b9\u7d2f|\u9ad8\u5cf0\u671f\u7b97\u529b\u4e0d\u8db3/',
    ],
    recoverableErrorActions: [],
    recoverableErrorWaitMs: 50,
    recoverableRetryCooldownMs: 200,
    streamingDone: { timeoutMs: 5000, stableMs: 100, pollMs: 50 },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <style>
        .assistant { margin: 80px 0 0 360px; width: 520px; }
        .retry-icon { margin-top: 16px; width: 28px; height: 28px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
      </style>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <div id="messages"></div>
      <script>
        window.retryClicked = false;
        document.querySelector('#send').addEventListener('click', () => {
          const message = document.createElement('div');
          message.className = 'assistant';
          message.innerHTML = '<p class="busy">\u4e0d\u597d\u610f\u601d\uff0c\u521a\u521a\u548cKimi\u804a\u7684\u4eba\u592a\u591a\u4e86\u3002Kimi\u6709\u70b9\u7d2f\u4e86\uff0c\u53ef\u4ee5\u665a\u70b9\u518d\u95ee\u6211\u4e00\u904d\u3002</p><p>\u9ad8\u5cf0\u671f\u7b97\u529b\u4e0d\u8db3\uff0c\u8bf7\u8010\u5fc3\u7b49\u5f85\uff0c\u6216<a>\u524d\u5f80\u5347\u7ea7</a></p><span class="retry-icon"><svg width="20" height="20"><path d="M4 10a6 6 0 1 1 2 4" /></svg></span>';
          document.querySelector('#messages').appendChild(message);
          message.querySelector('.retry-icon').addEventListener('click', () => {
            window.retryClicked = true;
            message.textContent = '\u6b63\u5728\u91cd\u65b0\u751f\u6210';
            setTimeout(() => {
              message.textContent = 'Final Kimi answer with enough detail after the retry, including a stable domain mention example.com for extraction.';
            }, 120);
          });
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Kimi retry prompt');

    assert.equal(await page.evaluate(() => window.retryClicked), true);
    assert.match(answer.rawText, /Final Kimi answer with enough detail after the retry/);
    assert.doesNotMatch(answer.rawText, /Kimi\u6709\u70b9\u7d2f/);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page does not collect intermediate search text as a completed answer', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    minAnswerChars: 20,
    pauseOnAnswerTimeout: false,
    streamingDone: { timeoutMs: 250, stableMs: 50, pollMs: 50 },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <div id="messages"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const message = document.createElement('div');
          message.className = 'assistant';
          message.textContent = '\u6b63\u5728\u641c\u7d22\u7f51\u9875 National Programme for the Adoption of the Acquis Chapter IV 20 \u4e2a\u7ed3\u679c';
          document.querySelector('#messages').appendChild(message);
        });
      </script>`);

    await performNewChat(page, config);
    await assert.rejects(
      () => submitPromptAndCollect(page, config, 'Intermediate search prompt'),
      /complete state before timeout/,
    );
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page treats answer timeout as a manual checkpoint and keeps waiting', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    minAnswerChars: 20,
    streamingDone: { timeoutMs: 120, stableMs: 50, pollMs: 50 },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };
  let checkpoints = 0;

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <div id="messages"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const message = document.createElement('div');
          message.className = 'assistant';
          message.textContent = '正在搜索网页 slow source 20 个结果';
          document.querySelector('#messages').appendChild(message);
          setTimeout(() => {
            message.textContent = 'Final answer after a slow search that should still be collected for this same sample.';
          }, 320);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Slow search prompt', async (message) => {
      checkpoints += 1;
      assert.match(message, /继续等待这一条样本/);
      await page.waitForTimeout(250);
    });

    assert.ok(checkpoints >= 1);
    assert.match(answer.rawText, /Final answer after a slow search/);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page respects minimum wait before accepting a valid-looking answer', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    minAnswerChars: 10,
    streamingDone: { timeoutMs: 2000, stableMs: 50, minWaitAfterStartMs: 300, pollMs: 50 },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <div id="messages"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const message = document.createElement('div');
          message.className = 'assistant';
          message.textContent = 'Draft answer that is long enough to look valid but should not be collected yet.';
          document.querySelector('#messages').appendChild(message);
          setTimeout(() => {
            message.textContent = 'Final answer after the platform finishes searching and composing the response.';
          }, 220);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Wait for final prompt');

    assert.equal(answer.rawText, 'Final answer after the platform finishes searching and composing the response.');
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page finishes when a stale stop button remains visible', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    minAnswerChars: 40,
    streamingDone: {
      timeoutMs: 2000,
      stableMs: 50,
      pollMs: 50,
      stopButtonSelectors: '#persistent-stop',
      maxStopButtonWaitAfterValidMs: 120,
      allowStaleStopButtonCompletion: true,
    },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <button id="persistent-stop">Stop</button>
      <div id="messages"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const message = document.createElement('div');
          message.className = 'assistant';
          message.textContent = 'Final answer is complete, but a stale stop-looking button remains visible on the page.';
          document.querySelector('#messages').appendChild(message);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Persistent stop prompt');

    assert.equal(answer.rawText, 'Final answer is complete, but a stale stop-looking button remains visible on the page.');
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page waits for the stop icon to return to a send arrow', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    minAnswerChars: 20,
    streamingDone: { timeoutMs: 2000, stableMs: 50, pollMs: 50 },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <style>
        #composer { position: absolute; left: 710px; top: 380px; width: 44px; height: 44px; border-radius: 22px; }
        #prompt { position: absolute; left: 120px; top: 360px; width: 640px; height: 80px; }
      </style>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <button id="composer" aria-label="Stop">
        <svg width="20" height="20"><rect x="6" y="6" width="8" height="8"></rect></svg>
      </button>
      <div id="messages"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const message = document.createElement('div');
          message.className = 'assistant';
          message.textContent = 'Final answer text is already visible, but the composer is still showing a stop icon.';
          document.querySelector('#messages').appendChild(message);
          setTimeout(() => {
            const composer = document.querySelector('#composer');
            composer.setAttribute('aria-label', 'Send');
            composer.className = 'send-ready';
            composer.innerHTML = '<svg width="20" height="20"><path d="M12 19V5 M5 12l7-7 7 7"></path></svg>';
          }, 260);
        });
      </script>`);

    await performNewChat(page, config);
    const startedAt = Date.now();
    const answer = await submitPromptAndCollect(page, config, 'Wait for arrow prompt');

    assert.ok(Date.now() - startedAt >= 240);
    assert.match(answer.rawText, /Final answer text is already visible/);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page can complete with stable text and answer action buttons when composer stays not ready', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    minAnswerChars: 40,
    streamingDone: {
      timeoutMs: 2000,
      stableMs: 80,
      pollMs: 50,
      allowTextStableWithActionButtons: true,
      detectLikelyStopButton: false,
    },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <style>
        #prompt { position: absolute; left: 160px; top: 500px; width: 640px; height: 80px; }
        #composer { position: absolute; left: 780px; top: 525px; width: 44px; height: 44px; border-radius: 22px; }
        .assistant { margin: 120px 0 0 160px; width: 620px; font-size: 16px; line-height: 1.5; }
        .actions { margin: 12px 0 0 160px; }
        .actions button { width: 34px; height: 30px; margin-right: 8px; }
      </style>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <button id="composer" aria-label="Generating">
        <svg width="20" height="20"><rect x="6" y="6" width="8" height="8"></rect></svg>
      </button>
      <div id="messages"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const answer = document.createElement('div');
          answer.className = 'assistant';
          answer.textContent =
            'Final DeepSeek answer is complete and stable with enough detail to accept even though the composer icon remains stale.';
          document.querySelector('#messages').appendChild(answer);
          const actions = document.createElement('div');
          actions.className = 'actions';
          actions.innerHTML = '<button aria-label="Copy">C</button><button aria-label="Like">L</button><button aria-label="Regenerate">R</button>';
          document.querySelector('#messages').appendChild(actions);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'DeepSeek stale composer prompt');

    assert.equal(answer.completionReason, 'text_stable_with_action_buttons');
    assert.equal(answer.finalState, 'completed');
    assert.match(answer.rawText, /Final DeepSeek answer is complete/);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page can complete with action buttons despite stale DeepSeek activity signals', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    minAnswerChars: 40,
    streamingDone: {
      timeoutMs: 2000,
      stableMs: 80,
      pollMs: 50,
      allowTextStableWithActionButtons: true,
      stopButtonSelectors: ['#stale-stop'],
      activitySelectors: ['#stale-activity'],
    },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <style>
        #prompt { position: absolute; left: 160px; top: 500px; width: 640px; height: 80px; }
        .assistant { margin: 120px 0 0 160px; width: 620px; font-size: 16px; line-height: 1.5; }
        .actions { margin: 12px 0 0 160px; }
        .actions button { width: 34px; height: 30px; margin-right: 8px; }
      </style>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <button id="stale-stop">Stop</button>
      <div id="stale-activity">stale activity marker</div>
      <div id="messages"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const answer = document.createElement('div');
          answer.className = 'assistant';
          answer.textContent =
            'Final DeepSeek answer is stable and complete while stale activity markers remain visible on the page.';
          document.querySelector('#messages').appendChild(answer);
          const actions = document.createElement('div');
          actions.className = 'actions';
          actions.innerHTML = '<button aria-label="Copy">C</button><button aria-label="Like">L</button><button aria-label="Regenerate">R</button>';
          document.querySelector('#messages').appendChild(actions);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'DeepSeek stale activity prompt');

    assert.equal(answer.completionReason, 'text_stable_with_action_buttons');
    assert.equal(answer.finalState, 'completed');
    assert.match(answer.rawText, /stale activity markers remain visible/);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page can complete a Qwen-style answer when a stale stop button remains', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    minAnswerChars: 40,
    streamingDone: {
      timeoutMs: 2000,
      stableMs: 80,
      pollMs: 50,
      allowTextStableWithActionButtons: true,
      stopButtonSelectors: ['#stale-stop'],
      sendReadySelectors: ['#ready-send'],
    },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <style>
        #prompt { position: absolute; left: 220px; top: 660px; width: 700px; height: 48px; }
        #ready-send, #stale-stop { position: absolute; left: 940px; top: 660px; width: 42px; height: 42px; }
        #stale-stop { left: 990px; }
        .assistant { margin: 130px 0 0 260px; width: 720px; font-size: 16px; line-height: 1.6; }
        .actions { margin: 14px 0 0 260px; }
        .actions button { width: 34px; height: 30px; margin-right: 8px; }
      </style>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <button id="ready-send" aria-label="Send">
        <svg width="20" height="20"><path d="M12 19V5 M5 12l7-7 7 7"></path></svg>
      </button>
      <button id="stale-stop" aria-label="Stop">
        <svg width="20" height="20"><rect x="6" y="6" width="8" height="8"></rect></svg>
      </button>
      <div id="messages"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const answer = document.createElement('div');
          answer.className = 'assistant';
          answer.textContent =
            'Final Qwen answer is complete and stable. The answer action buttons are visible, but a stale stop control remains visible on the page.';
          document.querySelector('#messages').appendChild(answer);
          const actions = document.createElement('div');
          actions.className = 'actions';
          actions.innerHTML = '<button aria-label="Copy">C</button><button aria-label="Like">L</button><button aria-label="Share">S</button>';
          document.querySelector('#messages').appendChild(actions);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Qwen stale stop prompt');

    assert.equal(answer.completionReason, 'text_stable_with_action_buttons');
    assert.equal(answer.finalState, 'completed');
    assert.match(answer.rawText, /Final Qwen answer is complete/);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page routes configured platform service error selectors to manual review', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    answerStartTimeoutMs: 1000,
    minAnswerChars: 30,
    streamingDone: { timeoutMs: 1500, stableMs: 80, manualReviewStableMs: 80, pollMs: 50 },
    stateSelectors: {
      serviceIssueSelectors: ['#service-error'],
    },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <div id="messages"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const answer = document.createElement('div');
          answer.className = 'assistant';
          answer.textContent = 'The answer area exists, but the platform displayed a service issue outside this answer block.';
          document.querySelector('#messages').appendChild(answer);
          const error = document.createElement('div');
          error.id = 'service-error';
          error.textContent = '系统错误，请重试';
          document.body.appendChild(error);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Doubao service issue prompt');

    assert.equal(answer.errorType, 'service_unavailable');
    assert.equal(answer.manualReviewRequired, true);
    assert.equal(answer.finalState, 'service_issue');
    assert.ok(answer.stateTrace.some((snapshot) => snapshot.selectors?.serviceIssue === '#service-error'));
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page records a platform service issue before an assistant answer starts', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    answerStartTimeoutMs: 1000,
    minAnswerChars: 30,
    streamingDone: { timeoutMs: 1500, stableMs: 80, manualReviewStableMs: 80, pollMs: 50 },
    stateSelectors: {
      serviceIssueSelectors: ['#service-error'],
    },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <div id="messages"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          document.querySelector('#prompt').value = '';
          const error = document.createElement('div');
          error.id = 'service-error';
          error.textContent = '系统错误，请稍后重试';
          document.body.appendChild(error);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Doubao pre-answer service issue prompt');

    assert.equal(answer.errorType, 'service_unavailable');
    assert.equal(answer.manualReviewRequired, true);
    assert.equal(answer.finalState, 'service_issue');
    assert.equal(answer.rawText, '系统错误，请稍后重试');
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page does not collect DeepSeek-style thinking text as final answer', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.ds-markdown',
    minAnswerChars: 40,
    streamingDone: { timeoutMs: 3000, stableMs: 80, pollMs: 50 },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <div class="ds-markdown"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const message = document.querySelector('.ds-markdown');
          message.textContent = '用户需要关于Robert Elsie为阿尔巴尼亚诗人Asdreni撰写的传记或主要资料。我需要提供可靠的传记、诗歌材料、职业亮点。为了全面覆盖，我将同时进行多项搜索。';
          setTimeout(() => {
            message.textContent = 'Final answer: the reliable source is Robert Elsie\\'s Albanian literature profile, with bibliography context and official archive references.';
          }, 260);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'DeepSeek thinking prompt');

    assert.match(answer.rawText, /^Final answer:/);
    assert.doesNotMatch(answer.rawText, /用户需要/);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page does not treat DeepSeek planning text as permission request or final answer', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.ds-markdown',
    minAnswerChars: 40,
    streamingDone: {
      timeoutMs: 3000,
      stableMs: 80,
      pollMs: 50,
      allowTextStableWithActionButtons: true,
      answerActionSelectors: ['button[aria-label="Copy"]'],
    },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <style>
        .ds-markdown { margin: 120px 0 0 160px; width: 620px; font-size: 16px; line-height: 1.5; }
        .actions { margin: 12px 0 0 160px; }
      </style>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <div class="ds-markdown"></div>
      <div class="actions"><button aria-label="Copy">C</button></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const message = document.querySelector('.ds-markdown');
          message.textContent = '用户可能要找的是一份“local list”条目，其中包含“49, The Fig Tree”。不过，用户的问题似乎更具体：“我需要确认2012年3月18日”。这看起来像是一份引用信息。我考虑直接搜索“49, The Fig Tree (formerly The Old Bill) (PDF)”。';
          setTimeout(() => {
            message.textContent = 'Final answer: the authoritative source is the London Borough of Hillingdon local list PDF, and the official domain to verify is hillingdon.gov.uk.';
          }, 260);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'DeepSeek planning prompt');

    assert.equal(answer.errorType, undefined);
    assert.match(answer.rawText, /^Final answer:/);
    assert.doesNotMatch(answer.rawText, /用户可能要找的是/);
    assert.doesNotMatch(answer.rawText, /我需要确认2012年3月18日/);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page waits for final text after English internal planning with action buttons', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    name: 'mock',
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    minAnswerChars: 40,
    sendConfirmation: { maxAttempts: 1, timeoutMs: 500, pollMs: 25 },
    streamingDone: {
      timeoutMs: 3000,
      stableMs: 100,
      minWaitAfterStartMs: 0,
      pollMs: 25,
      allowTextStableWithActionButtons: true,
      answerActionSelectors: ['button[aria-label="Copy"]'],
    },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <div class="assistant"></div>
      <button aria-label="Copy">Copy</button>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const answer = document.querySelector('.assistant');
          answer.textContent = 'The user is asking for an official source. Let me search for the original project page.';
          setTimeout(() => {
            answer.textContent = 'Final answer: the official project page identifies the publisher, historical context, and source archive.';
          }, 350);
        });
      </script>`);
    const answer = await submitPromptAndCollect(page, config, 'Find the official project source');
    assert.match(answer.rawText, /^Final answer:/u);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page does not collect Doubao loading and page chrome text as final answer', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.message-shell',
    minAnswerChars: 40,
    streamingDone: {
      timeoutMs: 3000,
      stableMs: 80,
      pollMs: 50,
      activitySelectors: ["[class*='loading-container']", "text=/找到\\s*\\d+\\s*篇资料/"],
    },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <div class="message-shell"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const message = document.querySelector('.message-shell');
          message.textContent = '豆包 新对话 Ctrl K AI 创作 云盘 更多 历史对话 新对话 内容由豆包 AI 生成，请仔细甄别 找到 24 篇资料 快速 超能模式 PPT 生成 AI 表格 图像生成 视频生成 更多';
          message.innerHTML += '<div class="loading-container-test"><span>找到 24 篇资料</span></div>';
          setTimeout(() => {
            message.textContent = 'Final Doubao answer with actual broadcaster, studio, publisher context and the official source after research is complete.';
          }, 260);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Doubao loading prompt');

    assert.match(answer.rawText, /^Final Doubao answer/);
    assert.doesNotMatch(answer.rawText, /找到 24 篇资料/);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page waits while an icon-only break button is visible near the input', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    minAnswerChars: 40,
    streamingDone: { timeoutMs: 3000, stableMs: 80, pollMs: 50, stopButtonSelectors: [] },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <style>
        .composer { position: fixed; left: 250px; right: 250px; bottom: 40px; height: 80px; border: 1px solid #ccc; }
        #prompt { position: absolute; left: 20px; top: 20px; width: 520px; height: 30px; }
        .break-btn-test { position: absolute; right: 20px; top: 20px; width: 36px; height: 36px; border-radius: 999px; background: #e8e8e8; }
      </style>
      <button id="send">Send</button>
      <div class="assistant"></div>
      <div class="composer">
        <textarea id="prompt"></textarea>
        <button class="break-btn-test" hidden>
          <svg width="24" height="24" viewBox="0 0 24 24"><rect x="8" y="8" width="8" height="8"></rect></svg>
        </button>
      </div>
      <script>
        window.breakHidden = false;
        document.querySelector('#send').addEventListener('click', () => {
          document.querySelector('.assistant').textContent = 'Final-looking answer should wait because the icon-only break button is still visible.';
          document.querySelector('.break-btn-test').hidden = false;
          setTimeout(() => {
            document.querySelector('.break-btn-test').hidden = true;
            window.breakHidden = true;
          }, 260);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Icon stop prompt');

    assert.equal(await page.evaluate(() => window.breakHidden), true);
    assert.match(answer.rawText, /Final-looking answer/);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page accepts a final answer that mentions webpage search results', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    minAnswerChars: 10,
    streamingDone: { timeoutMs: 2000, stableMs: 50, pollMs: 50 },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <div id="messages"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const message = document.createElement('div');
          message.className = 'assistant';
          message.textContent = '\u6839\u636e\u7f51\u9875\u641c\u7d22\u7ed3\u679c\uff0c\u8fd9\u662f\u4e00\u6bb5\u5df2\u7ecf\u5b8c\u6210\u7684\u56de\u7b54\uff0c\u800c\u4e0d\u662f\u4ecd\u5728\u641c\u7d22\u7684\u4e2d\u95f4\u72b6\u6001\u3002';
          document.querySelector('#messages').appendChild(message);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Webpage search wording prompt');

    assert.match(answer.rawText, /\u6839\u636e\u7f51\u9875\u641c\u7d22\u7ed3\u679c/);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page detects answer start when the same assistant node is updated', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    answerStartTimeoutMs: 1000,
    minAnswerChars: 20,
    streamingDone: { timeoutMs: 3000, stableMs: 80, pollMs: 50 },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <div class="assistant">Previous assistant answer from a prior turn that should not be collected.</div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          setTimeout(() => {
            document.querySelector('.assistant').textContent =
              'Final updated answer in the same assistant node with enough detail to be accepted.';
          }, 120);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Qwen reuses a node prompt');

    assert.equal(answer.rawText, 'Final updated answer in the same assistant node with enough detail to be accepted.');
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page records an explicit short model refusal', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    answerStartTimeoutMs: 1000,
    minAnswerChars: 120,
    streamingDone: { timeoutMs: 1500, stableMs: 200, refusalStableMs: 80, pollMs: 50 },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <div id="messages"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const answer = document.createElement('div');
          answer.className = 'assistant';
          answer.textContent = '抱歉，我无法回答你的问题';
          document.querySelector('#messages').appendChild(answer);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Refusal prompt');

    assert.equal(answer.errorType, 'model_refusal');
    assert.equal(answer.timedOut, false);
    assert.equal(answer.rawText, '抱歉，我无法回答你的问题');
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page records Kimi topic-redirect refusal below min answer length', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    name: 'kimi',
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    answerStartTimeoutMs: 1000,
    minAnswerChars: 120,
    streamingDone: {
      timeoutMs: 1500,
      stableMs: 200,
      refusalStableMs: 80,
      refusalActiveGraceMs: 80,
      refusalHardGraceMs: 200,
      pollMs: 25,
    },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <div id="messages"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const answer = document.createElement('div');
          answer.className = 'assistant';
          answer.textContent = '尊敬的用户您好，让我们换个话题再聊聊吧。';
          document.querySelector('#messages').appendChild(answer);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Kimi topic redirect refusal prompt');

    assert.equal(answer.errorType, 'model_refusal');
    assert.equal(answer.finalState, 'refusal');
    assert.equal(answer.timedOut, false);
    assert.equal(answer.rawText, '尊敬的用户您好，让我们换个话题再聊聊吧。');
  } finally {
    await page.close();
    await browser.close();
  }
});

test('Doubao ordinary refusal is recorded once without privacy-refusal retries', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const privacyRefusal = '很抱歉，出于隐私信息保护的考虑，我暂时无法提供相应信息。';
  const ordinaryRefusal =
    '针对这个问题我无法为你提供相应解答。你可以尝试提供其他话题，我会尽力为你提供支持和解答。';
  const config = {
    name: 'doubao',
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    answerStartTimeoutMs: 1000,
    minAnswerChars: 120,
    sendConfirmation: { maxAttempts: 1, timeoutMs: 500, pollMs: 25, log: false },
    streamingDone: {
      timeoutMs: 1500,
      stableMs: 200,
      refusalStableMs: 50,
      refusalActiveGraceMs: 50,
      refusalHardGraceMs: 150,
      pollMs: 25,
    },
    sameConversationRetry: {
      matchText: privacyRefusal,
      maxRetries: 5,
      retryDelayMs: 0,
    },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <div id="messages"></div>
      <script>
        window.sendCount = 0;
        document.querySelector('#send').addEventListener('click', () => {
          window.sendCount += 1;
          const answer = document.createElement('div');
          answer.className = 'assistant';
          answer.textContent = ${JSON.stringify(ordinaryRefusal)};
          document.querySelector('#messages').appendChild(answer);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Doubao ordinary refusal prompt');

    assert.equal(await page.evaluate(() => window.sendCount), 1);
    assert.equal(answer.errorType, 'model_refusal');
    assert.equal(answer.finalState, 'refusal');
    assert.equal(answer.rawText, ordinaryRefusal);
    assert.equal(answer.sameConversationRetry, undefined);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page completes a stable refusal despite stale stop and activity indicators', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    answerStartTimeoutMs: 1000,
    minAnswerChars: 120,
    streamingDone: {
      timeoutMs: 2000,
      stableMs: 200,
      refusalStableMs: 50,
      refusalActiveGraceMs: 100,
      refusalHardGraceMs: 250,
      pollMs: 25,
      stopButtonSelectors: ['#stop'],
      activitySelectors: ['#activity'],
    },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <button id="stop">Stop</button>
      <div id="activity">Generating</div>
      <div id="messages"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const answer = document.createElement('div');
          answer.className = 'assistant';
          answer.textContent = '抱歉，我无法回答你的问题';
          document.querySelector('#messages').appendChild(answer);
        });
      </script>`);

    const answer = await submitPromptAndCollect(page, config, 'Refusal with stale controls');

    assert.equal(answer.errorType, 'model_refusal');
    assert.equal(answer.finalState, 'refusal');
    assert.equal(answer.stateSummary.last_snapshot.refusal_signals_stale, true);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('Doubao privacy refusal resends the prompt in the same conversation and accepts a later answer', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const privacyRefusal = '很抱歉，出于隐私信息保护的考虑，我暂时无法提供相应信息。';
  const config = {
    name: 'doubao',
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    answerStartTimeoutMs: 1000,
    minAnswerChars: 40,
    streamingDone: { timeoutMs: 2000, stableMs: 80, refusalStableMs: 30, pollMs: 20 },
    sameConversationRetry: {
      matchText: privacyRefusal,
      maxRetries: 5,
      retryDelayMs: 0,
    },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <div id="messages"></div>
      <script>
        window.sendCount = 0;
        document.querySelector('#send').addEventListener('click', () => {
          window.sendCount += 1;
          const answer = document.createElement('div');
          answer.className = 'assistant';
          answer.textContent = window.sendCount <= 5
            ? ${JSON.stringify(privacyRefusal)}
            : 'Final Doubao answer after same-conversation retries with https://example.com for verification.';
          document.querySelector('#messages').appendChild(answer);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Doubao retry prompt');

    assert.equal(await page.evaluate(() => window.sendCount), 6);
    assert.equal(answer.errorType, undefined);
    assert.match(answer.rawText, /Final Doubao answer/);
    assert.deepEqual(answer.sameConversationRetry, { retries: 5, exhausted: false });
  } finally {
    await page.close();
    await browser.close();
  }
});

test('Doubao privacy refusal is recorded after five same-conversation retries are exhausted', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const privacyRefusal = '很抱歉，出于隐私信息保护的考虑，我暂时无法提供相应信息。';
  const config = {
    name: 'doubao',
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    answerStartTimeoutMs: 1000,
    minAnswerChars: 40,
    streamingDone: { timeoutMs: 2000, stableMs: 80, refusalStableMs: 30, pollMs: 20 },
    sameConversationRetry: {
      matchText: privacyRefusal,
      maxRetries: 5,
      retryDelayMs: 0,
    },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <div id="messages"></div>
      <script>
        window.sendCount = 0;
        document.querySelector('#send').addEventListener('click', () => {
          window.sendCount += 1;
          const answer = document.createElement('div');
          answer.className = 'assistant';
          answer.textContent = ${JSON.stringify(privacyRefusal)};
          document.querySelector('#messages').appendChild(answer);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Doubao retry exhaustion prompt');

    assert.equal(await page.evaluate(() => window.sendCount), 6);
    assert.equal(answer.errorType, 'model_refusal');
    assert.equal(answer.rawText, privacyRefusal);
    assert.deepEqual(answer.sameConversationRetry, { retries: 5, exhausted: true });
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page records refusal after a partial answer', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    answerStartTimeoutMs: 1000,
    minAnswerChars: 40,
    streamingDone: {
      timeoutMs: 2000,
      stableMs: 120,
      refusalStableMs: 80,
      pollMs: 50,
      stopButtonSelectors: ['#stop'],
    },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <button id="stop" style="display:none">Stop</button>
      <div id="messages"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          document.querySelector('#stop').style.display = 'block';
          const answer = document.createElement('div');
          answer.className = 'assistant';
          answer.textContent = 'Initial answer text that is long enough but still streaming and should not be collected yet.';
          document.querySelector('#messages').appendChild(answer);
          setTimeout(() => {
            answer.textContent = "Sorry, I can't continue to answer this request.";
            document.querySelector('#stop').style.display = 'none';
          }, 160);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Partial then refusal prompt');

    assert.equal(answer.errorType, 'model_refusal');
    assert.match(answer.rawText, /can't continue to answer/i);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page does not mark source uncertainty as a model refusal', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    answerStartTimeoutMs: 1000,
    minAnswerChars: 30,
    streamingDone: { timeoutMs: 1500, stableMs: 80, pollMs: 50 },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <div id="messages"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const answer = document.createElement('div');
          answer.className = 'assistant';
          answer.textContent = '我无法找到该报道的官方原文链接，但可以根据现有资料给出核查路径、可能的发布机构和后续验证建议。';
          document.querySelector('#messages').appendChild(answer);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Source uncertainty prompt');

    assert.equal(answer.errorType, undefined);
    assert.match(answer.rawText, /核查路径/);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page routes permission issues to manual review', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    answerStartTimeoutMs: 1000,
    minAnswerChars: 20,
    streamingDone: { timeoutMs: 1500, stableMs: 80, manualReviewStableMs: 80, pollMs: 50 },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <div id="messages"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const answer = document.createElement('div');
          answer.className = 'assistant';
          answer.textContent = '需要授权后才能访问该工具，请确认权限。';
          document.querySelector('#messages').appendChild(answer);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Permission prompt');

    assert.equal(answer.errorType, 'permission_required');
    assert.equal(answer.manualReviewRequired, true);
    assert.equal(answer.finalState, 'waiting_user_authorization');
    assert.ok(answer.stateTrace.some((snapshot) => snapshot.state === 'waiting_user_authorization'));
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page routes service and network issues to manual review', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    answerStartTimeoutMs: 1000,
    minAnswerChars: 20,
    streamingDone: { timeoutMs: 1500, stableMs: 80, manualReviewStableMs: 80, pollMs: 50 },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <div id="messages"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const answer = document.createElement('div');
          answer.className = 'assistant';
          answer.textContent = '服务繁忙，请稍后再试。';
          document.querySelector('#messages').appendChild(answer);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Service issue prompt');

    assert.equal(answer.errorType, 'service_unavailable');
    assert.equal(answer.manualReviewRequired, true);
    assert.equal(answer.finalState, 'service_issue');
    assert.ok(answer.stateTrace.some((snapshot) => snapshot.error_type === 'service_unavailable'));
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page keeps waiting while stable tool activity is visible', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '.assistant',
    answerStartTimeoutMs: 1000,
    minAnswerChars: 20,
    streamingDone: {
      timeoutMs: 2000,
      stableMs: 80,
      pollMs: 50,
      activitySelectors: ['#tool-loading'],
    },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <div id="messages"></div>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const loading = document.createElement('div');
          loading.id = 'tool-loading';
          loading.textContent = '调用工具中';
          document.body.appendChild(loading);
          const answer = document.createElement('div');
          answer.className = 'assistant';
          answer.textContent = '调用工具中';
          document.querySelector('#messages').appendChild(answer);
          setTimeout(() => {
            loading.remove();
            answer.textContent = 'Final answer after the tool activity completed with enough detail to collect.';
          }, 260);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Stable tool loading prompt');

    assert.equal(answer.errorType, undefined);
    assert.match(answer.rawText, /Final answer after the tool activity/);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('mock chat page falls back to a visible answer block when selectors do not match', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const config = {
    newChat: { actions: [{ type: 'none' }] },
    inputSelector: '#prompt',
    sendButtonSelector: '#send',
    assistantMessageSelector: '#missing-assistant-selector',
    answerStartTimeoutMs: 1000,
    minAnswerChars: 30,
    streamingDone: { timeoutMs: 3000, stableMs: 80, pollMs: 50 },
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent(`<!doctype html>
      <style>
        .sidebar { position: fixed; left: 0; top: 0; width: 240px; height: 100vh; }
        #prompt, #send { margin-left: 320px; }
        .qw-random-visible-block { margin-left: 320px; margin-top: 140px; width: 620px; font-size: 16px; line-height: 1.6; }
      </style>
      <div class="sidebar">New chat History Login</div>
      <textarea id="prompt"></textarea>
      <button id="send">Send</button>
      <main id="messages"></main>
      <script>
        document.querySelector('#send').addEventListener('click', () => {
          const block = document.createElement('div');
          block.className = 'qw-random-visible-block';
          block.innerHTML = 'Fallback answer block with enough detail for collection and a real link <a href="https://www.example.com/source">source</a>.';
          document.querySelector('#messages').appendChild(block);
        });
      </script>`);

    await performNewChat(page, config);
    const answer = await submitPromptAndCollect(page, config, 'Fallback visible block prompt');

    assert.match(answer.rawText, /Fallback answer block with enough detail/);
    assert.equal(answer.links[0].href, 'https://www.example.com/source');
  } finally {
    await page.close();
    await browser.close();
  }
});

test('guardPlatformBlocks detects hidden Cloudflare challenge markers', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  try {
    await page.setContent('<input type="hidden" name="cf-turnstile-response" value="">');
    await assert.rejects(
      () =>
        guardPlatformBlocks(
          page,
          {
            captchaOrRiskSelectors: ["input[name='cf-turnstile-response']"],
            loginExpiredSelectors: [],
          },
          async () => {},
        ),
      /Blocked by platform selector/,
    );
  } finally {
    await page.close();
    await browser.close();
  }
});

test('guardPlatformBlocks ignores hidden challenge markers after the chat input is usable', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  try {
    await page.setContent(`
      <input type="hidden" name="cf-turnstile-response" value="">
      <div id="prompt-textarea" contenteditable="true">ready</div>
    `);
    await guardPlatformBlocks(
      page,
      {
        inputSelector: ['#prompt-textarea'],
        captchaOrRiskSelectors: ["input[name='cf-turnstile-response']"],
        loginExpiredSelectors: [],
      },
      async () => {
        throw new Error('usable chat input should resolve hidden challenge markers');
      },
    );
  } finally {
    await page.close();
    await browser.close();
  }
});

test('guardPlatformBlocks ignores a generic Kimi login entry after the chat composer is ready', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    inputSelector: ['#prompt'],
    captchaOrRiskSelectors: [],
    loginExpiredSelectors: ["button:has-text('登录')"],
    ignoreLoginExpiredWhenInputReady: true,
  };

  try {
    await page.setContent('<button>登录</button><div id="prompt" contenteditable="true"></div>');
    await guardPlatformBlocks(page, config, async () => {
      throw new Error('a usable chat composer must suppress generic login-entry text');
    });

    await page.setContent('<button>登录</button>');
    await guardPlatformBlocks(page, config, async () => {
      await page.setContent('<button>登录</button><div id="prompt" contenteditable="true"></div>');
    });

    config.loginExpiredSelectors = ["input[placeholder*='手机号']"];
    await page.setContent('<input placeholder="手机号">');
    await assert.rejects(
      () => guardPlatformBlocks(page, config, async () => {}),
      /Login expired selector/,
    );
  } finally {
    await page.close();
    await browser.close();
  }
});

test('guardPlatformBlocks ignores hidden risk wording but still catches visible risk wording', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  const config = {
    captchaOrRiskSelectors: ['text=/captcha|验证码|安全验证|人机验证|风控|risk/i'],
    loginExpiredSelectors: [],
  };

  try {
    await page.setContent('<div style="display:none">风控</div><main>normal page</main>');
    await guardPlatformBlocks(page, config, async () => {
      throw new Error('hidden risk wording should not pause');
    });

    await page.setContent('<main>风控</main>');
    await assert.rejects(
      () =>
        guardPlatformBlocks(page, config, async () => {
          // Simulate the user pressing Enter while the visible block is still present.
        }),
      /Blocked by platform selector/,
    );
  } finally {
    await page.close();
    await browser.close();
  }
});

test('prepareChat clicks enabled inactive toggles but skips active toggles', async (t) => {
  let browser;
  try {
    const channel = getSystemBrowserChannel();
    browser = await chromium.launch({
      channel: process.env.LEL_TEST_BROWSER_CHANNEL || channel || undefined,
      headless: true,
    });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html>
      <button id="inactive" class="enabled">深度思考</button>
      <button id="active" class="active">智能搜索</button>
      <script>
        window.clicked = [];
        document.querySelector('#inactive').addEventListener('click', () => window.clicked.push('inactive'));
        document.querySelector('#active').addEventListener('click', () => window.clicked.push('active'));
      </script>`);

    await prepareChat(page, {
      prepareChat: {
        actions: [
          { type: 'ensureToggleOn', selector: '#inactive' },
          { type: 'ensureToggleOn', selector: '#active' },
        ],
      },
    });

    assert.deepEqual(await page.evaluate(() => window.clicked), ['inactive']);
  } finally {
    await page.close();
    await browser.close();
  }
});
