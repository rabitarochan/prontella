import * as monaco from 'monaco-editor';
import { toMonacoMarkers, type LspDiagnosticReport } from './convert';
import type { LspSession } from './session';
import { modelUriString, parseModelUri, parseWireUri } from './uri';

/**
 * pull 診断 (`textDocument/diagnostic`) → Monaco マーカー。push (`publishDiagnostics`) はサーバーが捨てる。
 *
 * - 取得の契機は documents.ts が持つ: didOpen 直後 (0ms) / didChange の 300ms デバウンス後 / reset 後の
 *   再 didOpen / セッションが ready になった時。同期そのものはデバウンスしない (MVP の不変条件)
 * - **owner モデルだけ**が取得する。非 owner のモデルはサーバー側の本文と一致していないので、owner の
 *   マーカーをコピーせず空にする (位置がずれる)。取得は所有権を奪わないよう session.request を直接使う
 * - owner は `'lsp'` 固定 (内蔵 TS の `'typescript'` と分ける)。モデル dispose / LS reset / 所有権喪失で空で上書き
 * - `previousResultId` は使わない (常に full)。`unchanged` が来たら既存を維持
 */

export const DIAGNOSTIC_DEBOUNCE_MS = 300;
// Roslyn は didOpen 直後の pull が意味解析の完了と同期する (25 プロジェクトで ≈ 5 秒)。補完の 3 秒より長く取る
const TIMEOUT_MS = 30_000;
const OWNER = 'lsp';

interface State {
  timer: ReturnType<typeof setTimeout> | null;
  /** 応答が古い pull のものなら捨てる */
  gen: number;
}

const states = new WeakMap<monaco.editor.ITextModel, State>();

export function scheduleDiagnostics(model: monaco.editor.ITextModel, session: LspSession, uri: string, delayMs: number): void {
  let st = states.get(model);
  if (!st) {
    st = { timer: null, gen: 0 };
    states.set(model, st);
  }
  if (st.timer) clearTimeout(st.timer);
  const gen = ++st.gen;
  st.timer = setTimeout(() => {
    st.timer = null;
    void pull(model, session, uri, gen);
  }, delayMs);
}

/** 保留中の取得を捨て、マーカーを消す (モデル dispose / reset / 所有権喪失)。 */
export function clearDiagnostics(model: monaco.editor.ITextModel): void {
  const st = states.get(model);
  if (st) {
    if (st.timer) clearTimeout(st.timer);
    st.timer = null;
    st.gen++;
  }
  if (!model.isDisposed()) monaco.editor.setModelMarkers(model, OWNER, []);
}

async function pull(model: monaco.editor.ITextModel, session: LspSession, uri: string, gen: number): Promise<void> {
  if (!session.ready || model.isDisposed()) return; // ready になった時に documents.ts が取り直す
  const r = await session.request<LspDiagnosticReport>('textDocument/diagnostic', { textDocument: { uri } }, TIMEOUT_MS);
  if (states.get(model)?.gen !== gen || model.isDisposed()) return;
  if ('error' in r) {
    // not-owner (別ブラウザータブが本文を持っている) → このモデルの本文と一致しないので消す
    clearDiagnostics(model);
    return;
  }
  if (!r.result || r.result.kind === 'unchanged') return;
  const ref = parseModelUri(model.uri.toString());
  const token = session.rootToken;
  const markers = toMonacoMarkers(r.result.items ?? [], (u) => {
    if (!ref || !token) return null;
    const w = parseWireUri(token, u);
    return w?.kind === 'file' ? modelUriString(ref.leafId, w.path) : null;
  });
  monaco.editor.setModelMarkers(
    model,
    OWNER,
    markers.map((m) => ({
      ...m,
      code: typeof m.code === 'object' ? { value: m.code.value, target: monaco.Uri.parse(m.code.target) } : m.code,
      relatedInformation: m.relatedInformation?.map((r) => ({ ...r, resource: monaco.Uri.parse(r.resource) })),
    })),
  );
}
