// Thin fetch wrappers against the isolated bench server's HTTP/WS API.
// server/index.ts のルート形状に合わせているだけで、隔離ポート以外は本物と同じ。

export async function getRepos(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/repos`);
  if (!res.ok) throw new Error(`GET /api/repos failed: ${res.status}`);
  return res.json();
}

export async function addRepo(port, repoPath) {
  const res = await fetch(`http://127.0.0.1:${port}/api/repos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: repoPath }),
  });
  if (!res.ok) throw new Error(`POST /api/repos failed: ${res.status}`);
  return res.json();
}

export async function createTerminal(port, cwd) {
  const res = await fetch(`http://127.0.0.1:${port}/api/terminals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd }),
  });
  if (!res.ok) throw new Error(`POST /api/terminals failed: ${res.status}`);
  return res.json();
}

export async function listTerminals(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/terminals`);
  if (!res.ok) throw new Error(`GET /api/terminals failed: ${res.status}`);
  return res.json();
}

export async function killTerminal(port, id) {
  const res = await fetch(`http://127.0.0.1:${port}/api/terminals/${id}/kill`, { method: 'POST' });
  return res.json();
}

/** 検証用の生ソケット (ブラウザーを介さない、Node グローバル WebSocket)。 */
export function openTermWs(port, id) {
  return new WebSocket(`ws://127.0.0.1:${port}/ws/term?id=${id}`);
}

export function waitOpen(ws, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws open timeout')), timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(e); }, { once: true });
  });
}
