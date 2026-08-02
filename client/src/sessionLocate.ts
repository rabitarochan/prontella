import { isActive, isArchived } from './repoSections';
import type { ActiveRepo, ArchivedRepo, Repo, Worktree } from './types';

/**
 * セッションの cwd から所属先を解決する純関数。DOM/store には一切触れない。
 */

export type SessionLocation =
  | { kind: 'worktree'; repo: ActiveRepo; worktree: Worktree }
  | { kind: 'archived'; repo: ArchivedRepo };

// パス表記の揺れ (区切り文字 \ と /、大文字小文字、末尾スラッシュ) を吸収する正規化。
// agentEvents.ts の findWorktree から移設 (意味論は変えない)。
export function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * cwd が属する worktree (アクティブ) または repo (アーカイブ済み) を引く。
 *
 * - Tier 1: アクティブ repo の `worktrees[].path` と完全一致
 * - Tier 2: アーカイブ済み repo の `knownWorktreePaths` と完全一致
 *
 * 包含判定・prefix 判定は絶対に使わない — `server/index.ts` が worktree を repo の
 * **兄弟**ディレクトリーに作るため、Deck が作った worktree は原理的に `repo.path` 配下に
 * 来ない (包含判定では解決不能)。かつ prefix 判定は `C:\x\proj` が `C:\x\proj-old\...` の
 * ような無関係な兄弟リポジトリーに誤爆しうる (D4)。どちらも外れたら null。
 */
export function locateSession(repos: Repo[], cwd: string): SessionLocation | null {
  const key = normPath(cwd);
  for (const repo of repos) {
    if (!isActive(repo)) continue;
    for (const worktree of repo.worktrees) {
      if (normPath(worktree.path) === key) return { kind: 'worktree', repo, worktree };
    }
  }
  for (const repo of repos) {
    if (!isArchived(repo)) continue;
    // ワイヤー契約は TS で守れない (server/index.ts の res.json(result) に型注釈が無く、
    // レスポンス組み立てが複数箇所に分散している)。knownWorktreePaths が付いてこない
    // 実データはコンパイル時に検出できないため、欠落/非配列でも throw せず [] 扱いにする
    // (isActive/isArchived をキー欠落に耐える向きに書いたのと同じ理由)。
    const knownWorktreePaths = Array.isArray(repo.knownWorktreePaths) ? repo.knownWorktreePaths : [];
    for (const path of knownWorktreePaths) {
      if (normPath(path) === key) return { kind: 'archived', repo };
    }
  }
  return null;
}
