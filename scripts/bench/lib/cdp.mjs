// Minimal CDP client over the browser WebSocket endpoint (Node global WebSocket).
// Adapted from the scratch helpers used in the terminal-monitor investigation
// (cdp.mjs / mon03-helpers.mjs) — see pj-isolated-verify skill for the traps
// this shape avoids (trusted vs untrusted events, addInitScript session lifetime, etc).
import { setTimeout as delay } from 'node:timers/promises';

export async function connectBrowser(port) {
  const verRes = await fetch(`http://127.0.0.1:${port}/json/version`);
  const ver = await verRes.json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(e));
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  });
  function send(method, params = {}, sessionId) {
    const id = nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(payload));
    });
  }
  function on(method, cb) {
    listeners.push((msg) => {
      if (msg.method === method) cb(msg.params, msg.sessionId);
    });
  }
  return { ws, send, on };
}

async function attach(browser, url, newWindow) {
  const { targetId } = await browser.send('Target.createTarget', { url: url ?? 'about:blank', newWindow: !!newWindow });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Page.enable', {}, sessionId);
  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('DOM.enable', {}, sessionId);
  return { targetId, sessionId };
}

export async function newPage(browser, url) {
  return attach(browser, url, false);
}

export async function newWindow(browser, url) {
  return attach(browser, url, true);
}

export async function evaluate(browser, sessionId, expression, awaitPromise = true) {
  const res = await browser.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  }, sessionId);
  if (res.exceptionDetails) {
    throw new Error('evaluate failed: ' + JSON.stringify(res.exceptionDetails));
  }
  return res.result.value;
}

// 罠18 (pj-isolated-verify): 登録は CDP セッションと寿命を共にする。
// ページごとに1回だけ呼ぶこと (reload をまたいで再登録は不要 — 自動的に再実行される)。
export async function addInitScript(browser, sessionId, source) {
  return browser.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId);
}

export async function navigate(browser, sessionId, url) {
  await browser.send('Page.navigate', { url }, sessionId);
}

export async function reload(browser, sessionId) {
  await browser.send('Page.reload', {}, sessionId);
}

export async function bringToFront(browser, sessionId) {
  await browser.send('Page.bringToFront', {}, sessionId);
}

export async function activateTarget(browser, targetId) {
  await browser.send('Target.activateTarget', { targetId });
}

export async function trustedClick(browser, sessionId, x, y) {
  await browser.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1,
  }, sessionId);
  await browser.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
  }, sessionId);
}

// 罠10 (pj-isolated-verify): mouseMoved は 1 発あたり ~5 秒化けることがあるため、
// タイミング計測を含むドラッグでは意図的に mousePressed/mouseReleased のみで組む
// ケースと使い分ける。ここでは実際のドラッグ軌跡が要る (resize storm) ので使う —
// 呼び出し側は計測窓をこの関数呼び出し全体で取ること。
export async function dragSeparator(browser, sessionId, x0, y0, x1, y1, steps = 30, stepDelayMs = 50) {
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 }, sessionId);
  for (let i = 1; i <= steps; i++) {
    const x = x0 + (x1 - x0) * (i / steps);
    const y = y0 + (y1 - y0) * (i / steps);
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left' }, sessionId);
    await delay(stepDelayMs);
  }
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 }, sessionId);
}

export async function rectOf(browser, sessionId, selector) {
  return evaluate(browser, sessionId, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2, left:r.left, top:r.top, w: r.width, h: r.height }; })()`);
}

export async function rectOfNth(browser, sessionId, selector, index) {
  return evaluate(browser, sessionId, `(() => { const els = document.querySelectorAll(${JSON.stringify(selector)}); const el = els[${index}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2, left:r.left, top:r.top, w:r.width, h:r.height }; })()`);
}

// `.term-group .term-tab-buttons .codicon-split-horizontal` の親 button の中心。
export async function rectOfSplitButton(browser, sessionId) {
  return evaluate(browser, sessionId, `(() => {
    const icon = document.querySelector('.term-group .term-tab-buttons .codicon-split-horizontal');
    const btn = icon && icon.closest('button');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
}

export async function performanceEnable(browser, sessionId) {
  await browser.send('Performance.enable', {}, sessionId);
}

export async function getMetrics(browser, sessionId) {
  const { metrics } = await browser.send('Performance.getMetrics', {}, sessionId);
  const map = {};
  for (const m of metrics) map[m.name] = m.value;
  return map;
}

export function diffMetrics(before, after, keys) {
  const out = {};
  for (const k of keys) out[k] = (after[k] ?? 0) - (before[k] ?? 0);
  return out;
}

export const METRIC_KEYS = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'JSHeapUsedSize'];

export { delay };
