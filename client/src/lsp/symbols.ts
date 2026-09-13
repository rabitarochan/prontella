import { enabledServers } from './index';
import type { ServerId } from './languages';
import { peekLspSession } from './session';
import { parseWireUri } from './uri';

/**
 * ワークスペースのシンボル検索 (`workspace/symbol`)。Ctrl+P の `#` 接頭辞から呼ぶ。
 *
 * - root の**既に張られている** ready なセッションだけに投げる (無ければ空)。検索のために LS を起動しない
 * - サーバー側は C# の複数ソリューションへ fan-out して連結済み。ここでは TS と C# の結果を連結する
 * - root 外 (`-ext`) の結果は落とす (LS は原則ソースのシンボルしか返さない。RESULTS.md フェーズ 3)
 * - Roslyn は空クエリーに 0 件、tsgo は全件を返す → 空クエリーでは投げない (呼び出し側)
 */

export interface LspSymbolInformation {
  name: string;
  /** LSP SymbolKind 1..26 */
  kind: number;
  containerName?: string;
  location: { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } };
}

export interface SymbolHit {
  name: string;
  kind: number;
  containerName?: string;
  /** root 相対 */
  path: string;
  line: number;
  column: number;
  server: ServerId;
}

const TIMEOUT_MS = 10_000;
const LIMIT = 100;

export async function searchWorkspaceSymbols(root: string, query: string): Promise<SymbolHit[]> {
  const sessions = [...enabledServers].map((id) => peekLspSession(root, id)).filter((s) => s !== null && s.ready);
  const lists = await Promise.all(
    sessions.map(async (s) => {
      const r = await s!.request<LspSymbolInformation[]>('workspace/symbol', { query }, TIMEOUT_MS);
      return 'error' in r || !Array.isArray(r.result) ? [] : r.result.map((sym) => toHit(sym, s!.rootToken!, s!.serverId));
    }),
  );
  const out: SymbolHit[] = [];
  const seen = new Set<string>();
  for (const h of lists.flat()) {
    if (!h) continue;
    const key = `${h.path}\0${h.line}\0${h.column}\0${h.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= LIMIT) break;
  }
  return out;
}

function toHit(sym: LspSymbolInformation, rootToken: string, server: ServerId): SymbolHit | null {
  if (!sym || typeof sym.name !== 'string' || !sym.location?.uri) return null;
  const wire = parseWireUri(rootToken, sym.location.uri);
  if (!wire || wire.kind !== 'file') return null;
  const start = sym.location.range?.start ?? { line: 0, character: 0 };
  return { name: sym.name, kind: sym.kind, containerName: sym.containerName, path: wire.path, line: start.line + 1, column: start.character + 1, server };
}

/**
 * LSP SymbolKind (File=1 … TypeParameter=26) → codicon 名 (`codicon-symbol-<name>`)。Monaco 同梱の
 * codicon フォントに揃える。表の外は `symbol-misc`
 */
const SYMBOL_ICONS = [
  'symbol-misc', // 0
  'symbol-file',
  'symbol-module',
  'symbol-namespace',
  'symbol-package',
  'symbol-class',
  'symbol-method',
  'symbol-property',
  'symbol-field',
  'symbol-constructor',
  'symbol-enum',
  'symbol-interface',
  'symbol-function',
  'symbol-variable',
  'symbol-constant',
  'symbol-string',
  'symbol-number',
  'symbol-boolean',
  'symbol-array',
  'symbol-object',
  'symbol-key',
  'symbol-null',
  'symbol-enum-member',
  'symbol-struct',
  'symbol-event',
  'symbol-operator',
  'symbol-type-parameter',
];

export function symbolIcon(kind: number): string {
  return SYMBOL_ICONS[kind] ?? 'symbol-misc';
}
