// Source strings injected into the page via Page.addScriptToEvaluateOnNewDocument
// (cdp.mjs#addInitScript). Kept as plain template strings (no bundler) so the
// harness has zero extra dependencies.

/**
 * WebSocket フレーム計測 + longtask 集計。
 *
 * - `window.WebSocket` を素通し継承のサブクラスに差し替え、URL の pathname ごと
 *   (`/ws/term`, `/ws/events`, ...) に送受信フレーム数・種別・バイト数を積算する
 *   (pj-isolated-verify skill の「WebSocket の接続そのものを測る」節と同じ手法)。
 * - `PerformanceObserver({type:'longtask'})` で件数と合計 ms を累積する。
 * - `window.__benchSnapshot()` で現在の累積値を JSON で取り出せる(呼び出し側は
 *   フェーズの前後でこれを呼び、差分をとる — 大量ポーリングを避けるための設計)。
 * - `window.__benchCloseSockets(pathname)` で指定 pathname のソケットを外部から
 *   close できる (M4 の再接続嵐計測用)。
 */
export function benchInstrumentationScript() {
  return `(() => {
    if (window.__bench) return;
    const state = { byPath: {}, longtasks: { count: 0, totalMs: 0 }, sockets: [] };
    window.__bench = state;
    function pathOf(url) {
      try { return new URL(url, location.href).pathname; } catch { return String(url); }
    }
    function bucket(p) {
      if (!state.byPath[p]) {
        state.byPath[p] = {
          socketCount: 0,
          sent: {}, received: {},
          bytesSent: 0, bytesReceived: 0,
          bytesByTypeReceived: {},
        };
      }
      return state.byPath[p];
    }
    function typeOf(raw) {
      try { const o = JSON.parse(raw); return typeof o.type === 'string' ? o.type : 'unknown'; } catch { return 'nonjson'; }
    }
    function byteLen(s) {
      try { return new TextEncoder().encode(s).length; } catch { return s.length; }
    }
    const NativeWS = window.WebSocket;
    class BenchWebSocket extends NativeWS {
      constructor(url, protocols) {
        super(url, protocols);
        this.__benchPath = pathOf(url);
        bucket(this.__benchPath).socketCount++;
        state.sockets.push(this);
        this.addEventListener('message', (ev) => {
          if (typeof ev.data !== 'string') return;
          const b = bucket(this.__benchPath);
          const t = typeOf(ev.data);
          b.received[t] = (b.received[t] || 0) + 1;
          const len = byteLen(ev.data);
          b.bytesReceived += len;
          b.bytesByTypeReceived[t] = (b.bytesByTypeReceived[t] || 0) + len;
        });
      }
      send(data) {
        if (typeof data === 'string') {
          const b = bucket(this.__benchPath);
          const t = typeOf(data);
          b.sent[t] = (b.sent[t] || 0) + 1;
          b.bytesSent += byteLen(data);
        }
        return super.send(data);
      }
    }
    window.WebSocket = BenchWebSocket;
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          state.longtasks.count++;
          state.longtasks.totalMs += e.duration;
        }
      });
      po.observe({ type: 'longtask', buffered: true });
    } catch {}
    window.__benchSnapshot = () => JSON.parse(JSON.stringify({ byPath: state.byPath, longtasks: state.longtasks }));
    window.__benchCloseSockets = (pathSuffix) => {
      let n = 0;
      for (const ws of state.sockets) {
        if (ws.__benchPath === pathSuffix && ws.readyState === NativeWS.OPEN) { ws.close(); n++; }
      }
      return n;
    };
  })();`;
}

/** ページ A (worktree) 用: store.ts の Selection 形式 (prontella.selected) を直接書く。 */
export function selectionInitScript(repoId, worktreePath) {
  return `try {
    localStorage.setItem('prontella.selected', JSON.stringify({ repoId: ${JSON.stringify(repoId)}, worktreePath: ${JSON.stringify(worktreePath)} }));
  } catch {}`;
}

/**
 * ページ B (monitor) 用: monitorViewStore.ts のセッションストレージキー。
 *
 * `prontella.selected` は localStorage (= 同一オリジンの全タブ/ウィンドウで共有) なので、
 * ページ A の init script が書いた選択がここにも見える。App.tsx の「選択優先」effect が
 * 選択残存を検知すると monitorActive を即座に false へ戻してしまう (layout/mainMode.ts
 * のコメント参照) ため、このページ自身の document では選択を持たない状態にしてから
 * monitorActive を立てる。pj-isolated-verify 罠 (「消去は addInitScript に仕込んでから
 * navigate」) と同型。
 */
export function monitorInitScript() {
  return `try {
    localStorage.removeItem('prontella.selected');
    sessionStorage.setItem('prontella.monitorActive', '1');
  } catch {}`;
}
