import path from 'node:path';
import { safeResolve } from '../files.js';

/**
 * `.vscode/launch.json` 互換の起動設定 (純関数)。
 *
 * - JSONC (コメント・末尾カンマ・BOM) を受ける。正規表現一発では文字列リテラル内の `//` を壊すので状態機械
 * - 対象は `type` ∈ {node, pwa-node} かつ `request` ∈ {launch, attach} だけ。不正な 1 件は捨てて warnings に理由
 * - 変数は `${workspaceFolder}` と `${file}` のみ置換する。未知の `${…}` は残さず**エラー** (node にそのまま渡さない)
 * - `console` は常に `internalConsole` に上書きする。runInTerminal 逆要求は MVP で受けない (RESULTS.md D9)。
 *   VS Code の既定は integratedTerminal なので、上書きしないと launch.json をそのまま使ったとき黙って止まらない
 * - クライアントは設定の本体を送ってこない (`{name}` か `{file}` だけ)。本体はここで組む
 */

export const NODE_TYPES: ReadonlySet<string> = new Set(['node', 'pwa-node']);
const REQUESTS: ReadonlySet<string> = new Set(['launch', 'attach']);
const MAX_TEXT = 256 * 1024;
const MAX_DEPTH = 8;

export type LaunchConfig = Record<string, unknown> & { name: string; type: string; request: 'launch' | 'attach' };

export interface LaunchConfigSummary {
  name: string;
  type: string;
  request: 'launch' | 'attach';
}

/** コメント (行・ブロック) と末尾カンマと BOM を落とす。文字列リテラルの中は触らない。 */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      // 文字列: エスケープを飛ばしながら閉じ引用符まで写す
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === ',') {
      // 末尾カンマ: 空白を飛ばした次が } か ] なら捨てる
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') i++;
      else out += c, i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.codePointAt(i)!;
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** 文字列値に制御文字が無く、深さが上限内かを見る。理由を返す (null = OK) */
function checkTree(value: unknown, depth: number): string | null {
  if (depth > MAX_DEPTH) return `ネストが ${MAX_DEPTH} 段を超えています`;
  if (typeof value === 'string') return hasControlChar(value) ? '制御文字を含む文字列があります' : null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const r = checkTree(v, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) {
      const r = checkTree(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

export function parseLaunchConfigs(text: string): { configs: LaunchConfig[]; warnings: string[] } {
  const warnings: string[] = [];
  if (text.length > MAX_TEXT) return { configs: [], warnings: [`launch.json が ${MAX_TEXT} バイトを超えています`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch (e) {
    return { configs: [], warnings: [`launch.json を解釈できません: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const list = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { configurations?: unknown }).configurations : undefined;
  if (!Array.isArray(list)) return { configs: [], warnings: ['launch.json に configurations 配列がありません'] };
  const configs: LaunchConfig[] = [];
  list.forEach((item, i) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return void warnings.push(`configurations[${i}] はオブジェクトではありません`);
    const c = item as Record<string, unknown>;
    if (typeof c.name !== 'string' || c.name.length === 0 || hasControlChar(c.name)) return void warnings.push(`configurations[${i}] の name が不正です`);
    if (typeof c.type !== 'string' || !NODE_TYPES.has(c.type)) return; // 他言語の設定は黙って対象外
    if (typeof c.request !== 'string' || !REQUESTS.has(c.request)) return void warnings.push(`${c.name}: request は launch か attach が必要です`);
    const bad = checkTree(c, 1);
    if (bad) return void warnings.push(`${c.name}: ${bad}`);
    configs.push(c as LaunchConfig);
  });
  return { configs, warnings };
}

export interface Variables {
  workspaceFolder: string;
  /** `${file}` の置換先 (絶対パス)。無いのに参照されたらエラー */
  file?: string;
}

const VAR_RE = /\$\{([^}]*)\}/g;

/** `${workspaceFolder}` / `${file}` を埋める。他の `${…}` はエラー (`${env:X}` 等を node に渡さない)。 */
export function substituteVariables(value: unknown, vars: Variables): { ok: true; value: unknown } | { ok: false; error: string } {
  let error: string | null = null;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.replace(VAR_RE, (_m, name: string) => {
        if (name === 'workspaceFolder') return vars.workspaceFolder;
        if (name === 'file') {
          if (vars.file === undefined) error ??= '${file} を使う設定はファイルを開いた状態で起動してください';
          return vars.file ?? '';
        }
        error ??= `対応していない変数です: \${${name}}`;
        return '';
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(value);
  return error ? { ok: false, error } : { ok: true, value: out };
}

/**
 * launch.json が無い/使わないときの内蔵既定: 開いているファイルを node で実行する。
 * `.ts` は root に tsx があれば `--import tsx` (RESULTS.md D6)。無ければ既定を出さない (launch.json 任せ)。
 */
export function defaultConfig(root: string, absFile: string, exists: (abs: string) => boolean): LaunchConfig | null {
  const ext = path.extname(absFile).toLowerCase();
  const base: LaunchConfig = { type: 'pwa-node', request: 'launch', name: path.basename(absFile), program: absFile, cwd: root };
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return base;
  if ((ext === '.ts' || ext === '.mts' || ext === '.cts') && exists(path.join(root, 'node_modules', 'tsx', 'package.json'))) {
    return { ...base, runtimeArgs: ['--import', 'tsx'] };
  }
  return null;
}

/** 内蔵既定が使える拡張子か (UI の「アクティブファイルを実行」の活性判定)。 */
export function defaultAvailable(root: string, relFile: string, exists: (abs: string) => boolean): boolean {
  try {
    return defaultConfig(root, safeResolve(root, relFile), exists) !== null;
  } catch {
    return false;
  }
}

export interface LaunchRequestArgs {
  /** launch.json の name。無ければ内蔵既定 */
  name?: unknown;
  /** root 相対のファイル (内蔵既定の対象、または `${file}`) */
  file?: unknown;
}

/**
 * クライアントの `{name?, file?}` からアダプターへ渡す launch/attach 引数を組む。
 * クライアント由来のパスは safeResolve を通す (root 外は拒否)。
 */
export function resolveLaunchRequest(
  root: string,
  args: LaunchRequestArgs,
  deps: { readLaunchJson: () => string | null; exists: (abs: string) => boolean },
): { ok: true; config: LaunchConfig } | { ok: false; error: string } {
  let file: string | undefined;
  if (args.file !== undefined) {
    if (typeof args.file !== 'string') return { ok: false, error: 'file は文字列が必要です' };
    try {
      file = safeResolve(root, args.file);
    } catch {
      return { ok: false, error: 'file が root 外を指しています' };
    }
  }
  let config: LaunchConfig | null;
  if (args.name !== undefined) {
    if (typeof args.name !== 'string') return { ok: false, error: 'name は文字列が必要です' };
    const text = deps.readLaunchJson();
    if (text === null) return { ok: false, error: '.vscode/launch.json がありません' };
    const found = parseLaunchConfigs(text).configs.find((c) => c.name === args.name);
    if (!found) return { ok: false, error: `launch.json に "${args.name}" がありません` };
    const sub = substituteVariables(found, { workspaceFolder: root, file });
    if (!sub.ok) return sub;
    config = sub.value as LaunchConfig;
  } else {
    if (file === undefined) return { ok: false, error: 'name か file が必要です' };
    config = defaultConfig(root, file, deps.exists);
    if (!config) return { ok: false, error: 'このファイルは内蔵既定で実行できません (.js/.mjs/.cjs、または tsx がある root の .ts)' };
  }
  // VS Code は拡張側で `node` → `pwa-node` に読み替える。素の DAP サーバーは `node` を知らず launch に応答しない (隔離 E2E で実測)。
  // cwd の既定 `${workspaceFolder}` も VS Code が埋めるものなので、無ければ root にする
  return { ok: true, config: { cwd: root, ...config, type: config.type === 'node' ? 'pwa-node' : config.type, console: 'internalConsole' } };
}
