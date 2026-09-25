import * as monaco from 'monaco-editor';
import { startLspDocuments } from './documents';
import type { ServerId } from './languages';
import { registerLspProviders } from './providers';

/**
 * 起動時に 1 回。`mode === 'lsp'` のときだけ内蔵 TypeScript の補完/ホバー/定義を落として LSP を繋ぐ。
 *
 * 内蔵プロバイダーの登録は最初の TS モデル生成時に 1 回だけ行われ、その後の setModeConfiguration は
 * 効かない (docs/lsp-mvp-plan.md §1 A/B)。そのためアプリの描画前 (= 最初のモデルが生まれる前) に
 * 決める。設定はグローバルかつ起動時固定 — LSP 有効な root と無効な root を同時に開いていても一律。
 * 失敗時は既定 (builtin) に落ちるので既存挙動のまま。
 */
/** `mode === 'lsp'` のサーバー。空なら LSP は一切動かない (既存挙動)。 */
export const enabledServers = new Set<ServerId>();

export async function initLsp(): Promise<void> {
  let modes: Partial<Record<ServerId, string>> = {};
  try {
    const res = await fetch('/api/lsp/mode');
    if (res.ok) modes = (await res.json()) as Partial<Record<ServerId, string>>;
  } catch {
    // サーバー未達 → 全部無効
  }
  if (modes.typescript === 'lsp') {
    enabledServers.add('typescript');
    for (const d of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
      // diagnostics も落とす: 内蔵の構文エラーと LSP の診断 (client/src/lsp/diagnostics.ts) が二重に出るため。
      // LS 未検出 (disabled) の環境では構文エラー表示も消えるが、ステータスバーの「LSP: 未検出」で気づける
      d.setModeConfiguration({ ...d.modeConfiguration, completionItems: false, hovers: false, definitions: false, diagnostics: false });
    }
  }
  // C# には内蔵プロバイダーが無いので落とすものは無い
  if (modes.csharp === 'lsp') enabledServers.add('csharp');
  if (enabledServers.size === 0) return;
  registerLspProviders();
  startLspDocuments(enabledServers);
}

/**
 * ステータスバーからの切替: 設定を書き換えてリロードする。設定 UI は無いので、これが唯一の入口
 * (config.json の手編集を除く)。mode は起動時固定なのでリロードが要る。
 */
export async function switchLspMode(mode: 'builtin' | 'lsp' | 'off', server: ServerId = 'typescript'): Promise<void> {
  await fetch('/api/lsp/mode', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ server, mode }) });
  window.location.reload();
}
