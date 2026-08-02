/**
 * サイドバー整理機能(DnD 並び替え / ピン留め / アーカイブ)の純関数群。
 * child_process は元より fs にも一切触れない(I/O 禁止) — server/config.ts の
 * loadConfig/saveConfig が read-modify-write の中でこれらを呼ぶため、ここが同期・非同期の
 * どちらであってもテストが困難になる副作用を持ち込むと困る。
 *
 * RepoConfig 型は server/config.ts 側に定義がある(type-only import)。config.ts はこのファイルの
 * 値(normalizeRepoConfig 等)を import するため、循環 import を避けるべく value の依存方向は
 * 常に config.ts → repoOrder.ts の一方向にする(このファイルから config.ts の値は import しない)。
 */

import path from 'node:path';
import type { RepoConfig } from './config.js';

/**
 * config.ts の repoId と同じロジック(絶対パスの base64url)。config.ts から import すると
 * 上記の一方向依存が崩れるため、この 2 行だけ複製している。仕様を変えるときは両方を
 * 同期させること。
 */
function deriveId(repoPath: string): string {
  return Buffer.from(path.resolve(repoPath)).toString('base64url');
}

type Section = 'pinned' | 'normal' | 'archived';

function sectionOf(repo: RepoConfig): Section {
  if (repo.archived === true) return 'archived';
  if (repo.pinned === true) return 'pinned';
  return 'normal';
}

/**
 * 未知形状の入力から RepoConfig[] を復元する。**修復優先、落とすのは最後の手段**
 * (落とすのは path が非空文字列として使えないエントリーのみ)。
 * - id 欠落/不一致は常に path から再導出する(一致していれば再導出しても同じ値になるため、
 *   「欠落/不一致のときだけ」を場合分けする必要がない)
 * - name 欠落のみ path のベース名で補う(name はユーザー入力の可能性があるため欠落時のみ補完)
 * - pinned/archived は非 boolean を false 扱いにし、false のキーは出力に含めない
 *   (config.json の既存フォーマット「false は省略」に合わせる。saveConfig はこの結果を
 *   そのまま書き込むため、正規化の時点で圧縮形にしておく)
 * - pinned && archived が両立するときは archived を優先し pinned を落とす
 * - 未知キーは spread で保持する(現状の loadConfig は未知キーを往復させているため)
 */
export function normalizeRepoConfig(raw: unknown): RepoConfig[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: RepoConfig[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.path !== 'string' || rec.path === '') continue;
    const normalized = normalizeOne(rec, rec.path);
    if (seen.has(normalized.id)) continue; // id 重複は最初の 1 つを採用
    seen.add(normalized.id);
    result.push(normalized);
  }
  return result;
}

function normalizeOne(rec: Record<string, unknown>, pathValue: string): RepoConfig {
  const { id: _id, path: _path, name: _name, pinned: _pinned, archived: _archived, ...rest } = rec;
  const id = deriveId(pathValue);
  const name = typeof rec.name === 'string' && rec.name ? rec.name : path.basename(pathValue);
  let pinned = rec.pinned === true;
  const archived = rec.archived === true;
  if (pinned && archived) pinned = false; // 両立時は archived を優先

  const out: RepoConfig = { ...rest, id, path: pathValue, name };
  if (pinned) out.pinned = true;
  if (archived) out.archived = true;
  return out;
}

/**
 * pinned 群 → normal 群 → archived 群の**安定分割**。群内の相対順は入力の配列順を維持する。
 * セクションは保存せず repo のフラグから毎回導出する
 * (`archived ? 'archived' : pinned ? 'pinned' : 'normal'`)。
 */
export function sortBySection(repos: RepoConfig[]): RepoConfig[] {
  const pinned: RepoConfig[] = [];
  const normal: RepoConfig[] = [];
  const archived: RepoConfig[] = [];
  for (const repo of repos) {
    const bucket = sectionOf(repo) === 'pinned' ? pinned : sectionOf(repo) === 'archived' ? archived : normal;
    bucket.push(repo);
  }
  return [...pinned, ...normal, ...archived];
}

/**
 * PUT /api/repos/order の突合ロジック。リクエストは「アーカイブ済みを含む全 repo id を表示順に
 * 平坦化した完全列」だが、別タブでの追加/削除や古いクライアントとの競合を 409 で弾かず突合する。
 *
 * - リクエストにあり config に無い id → 落とす
 * - config にありリクエストに無い id → 現在の相対順を保って末尾に追加(削除として解釈しない)
 * - リクエスト内の重複 id → 最初の 1 つを採用
 * - 重複排除には `{}` ではなく Map/Set を使う(`__proto__` 等のプロトタイプ汚染を考慮不要にする)
 * - 不変条件: 入力 current の repo は 1 件も失われない
 */
export function reconcileOrder(
  current: RepoConfig[],
  requested: unknown,
): { ok: true; repos: RepoConfig[] } | { ok: false; error: string } {
  if (!Array.isArray(requested)) {
    return { ok: false, error: 'order は配列である必要があります' };
  }
  if (!requested.every((v) => typeof v === 'string')) {
    return { ok: false, error: 'order の要素はすべて文字列である必要があります' };
  }
  const limit = Math.max(1000, current.length);
  if (requested.length > limit) {
    return { ok: false, error: `order が長すぎます(上限 ${limit} 件)` };
  }

  const byId = new Map<string, RepoConfig>();
  for (const repo of current) {
    if (!byId.has(repo.id)) byId.set(repo.id, repo);
  }

  const used = new Set<string>();
  const ordered: RepoConfig[] = [];
  for (const id of requested as string[]) {
    if (used.has(id)) continue; // リクエスト内重複は最初の 1 つ
    const repo = byId.get(id);
    if (!repo) continue; // config に無い id は落とす
    used.add(id);
    ordered.push(repo);
  }
  for (const repo of current) {
    if (!used.has(repo.id)) {
      used.add(repo.id);
      ordered.push(repo); // config にのみある id は現在の相対順を保って末尾に追加
    }
  }

  return { ok: true, repos: sortBySection(ordered) };
}

/**
 * PATCH /api/repos/:id の pinned/archived 更新。相互排他をサーバー側で構造的に保証する
 * (pinned: true にしたら archived を落とす。逆も同様)。pinned/archived のどちらも
 * 指定されていない(= 空ボディ)場合は不要な保存を防ぐため ok:false にする。
 *
 * 着地位置(D10, 安定分割の帰結として仕様):
 * 通常→ピン留め=ピン群末尾 / ピン留め解除=通常群先頭 / 通常→アーカイブ=アーカイブ群先頭 /
 * アーカイブ解除=通常群末尾。これは配列内の元の位置と sortBySection の安定性から自然に決まる
 * (このためだけの特別扱いは不要)。
 */
export function applyFlags(
  repos: RepoConfig[],
  id: string,
  flags: { pinned?: unknown; archived?: unknown },
): { ok: true; repos: RepoConfig[] } | { ok: false; error: string } {
  const hasPinned = flags.pinned !== undefined;
  const hasArchived = flags.archived !== undefined;
  if (!hasPinned && !hasArchived) {
    return { ok: false, error: 'pinned または archived のいずれかを指定してください' };
  }
  if (hasPinned && typeof flags.pinned !== 'boolean') {
    return { ok: false, error: 'pinned は boolean である必要があります' };
  }
  if (hasArchived && typeof flags.archived !== 'boolean') {
    return { ok: false, error: 'archived は boolean である必要があります' };
  }
  if (hasPinned && hasArchived) {
    return { ok: false, error: 'pinned と archived は同時に指定できません' };
  }

  const idx = repos.findIndex((r) => r.id === id);
  if (idx === -1) {
    return { ok: false, error: `不明な id です: ${id}` };
  }

  const updated: RepoConfig = { ...repos[idx] };
  if (hasPinned) {
    if (flags.pinned === true) {
      updated.pinned = true;
      delete updated.archived;
    } else {
      delete updated.pinned;
    }
  }
  if (hasArchived) {
    if (flags.archived === true) {
      updated.archived = true;
      delete updated.pinned;
    } else {
      delete updated.archived;
    }
  }

  const result = repos.slice();
  result[idx] = updated;
  return { ok: true, repos: sortBySection(result) };
}
