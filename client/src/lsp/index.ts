import * as monaco from 'monaco-editor';
import { startLspDocuments } from './documents';
import { registerLspProviders } from './providers';

/**
 * 起動時に 1 回。`mode === 'lsp'` のときだけ内蔵 TypeScript の補完/ホバー/定義を落として LSP を繋ぐ。
 *
 * 内蔵プロバイダーの登録は最初の TS モデル生成時に 1 回だけ行われ、その後の setModeConfiguration は
 * 効かない (docs/lsp-mvp-plan.md §1 A/B)。そのためアプリの描画前 (= 最初のモデルが生まれる前) に
 * 決める。設定はグローバルかつ起動時固定 — LSP 有効な root と無効な root を同時に開いていても一律。
 * 失敗時は既定 (builtin) に落ちるので既存挙動のまま。
 */
export let lspEnabled = false;

export async function initLsp(): Promise<void> {
  let mode = 'builtin';
  try {
    const res = await fetch('/api/lsp/mode');
    if (res.ok) mode = ((await res.json()) as { mode?: string }).mode ?? 'builtin';
  } catch {
    // サーバー未達 → builtin
  }
  if (mode !== 'lsp') return;
  lspEnabled = true;
  for (const d of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
    // noSyntaxValidation は維持: 診断を出さない MVP では内蔵の構文エラー表示が唯一のエラー表示
    d.setModeConfiguration({ ...d.modeConfiguration, completionItems: false, hovers: false, definitions: false });
  }
  registerLspProviders();
  startLspDocuments();
}

/** ステータスバーの「内蔵に戻す」: 設定を builtin に書き戻してリロードする。 */
export async function switchToBuiltin(): Promise<void> {
  await fetch('/api/lsp/mode', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'builtin' }) });
  window.location.reload();
}
