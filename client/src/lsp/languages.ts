/**
 * 拡張子 → LSP languageId → 言語サーバー。純関数 (vitest 対象)。server/lsp/registry.ts と同じ表。
 *
 * `.tsx` は必ず typescriptreact: tsgo は最初の didOpen の languageId をファイルのスクリプト種別として
 * 固定するので、typescript で開くと JSX が型アサーションとして解釈され、開き直しても直らない
 * (scripts/lsp-spike/RESULTS.md S4)。`.csx` / `.cake` は Roslyn LS の対象外なので入れない。
 */
export type ServerId = 'typescript' | 'csharp';

const LANGUAGE_IDS: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
  '.cs': 'csharp',
};

export function languageIdFor(path: string): string | null {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot < 0 ? null : (LANGUAGE_IDS[name.slice(dot).toLowerCase()] ?? null);
}

export function serverIdFor(languageId: string): ServerId {
  return languageId === 'csharp' ? 'csharp' : 'typescript';
}

export function serverIdForPath(path: string): ServerId | null {
  const lang = languageIdFor(path);
  return lang === null ? null : serverIdFor(lang);
}
