import type { ActiveRepo, ArchivedRepo, Repo, RepoMeta } from './types';

/**
 * サイドバーのセクション分け (ピン留め/通常/アーカイブ) と並び替えのための純関数群。
 * DOM/store には一切触れない。
 */

/** `r.archived === true` を基準にする。キー欠落時に安全側 (= 非アーカイブ扱い) に倒すため。 */
export function isArchived(r: Repo): r is ArchivedRepo {
  return r.archived === true;
}

/**
 * `!isArchived(r)` として実装する。`r.archived === false` を基準にすると、サーバーが
 * `archived` キーを付け忘れたときに全件が非アクティブへ落ちてサイドバーが空になる
 * (D0)。キー欠落に耐える向きに書くこと。
 */
export function isActive(r: Repo): r is ActiveRepo {
  return !isArchived(r);
}

type Section = 'pinned' | 'normal' | 'archived';

function sectionOf(r: Repo): Section {
  if (isArchived(r)) return 'archived';
  return r.pinned ? 'pinned' : 'normal';
}

/** 配列順を保つ filter のみ (ソートしない)。 */
export function sectionize(repos: Repo[]): {
  pinned: ActiveRepo[];
  normal: ActiveRepo[];
  archived: ArchivedRepo[];
} {
  const pinned: ActiveRepo[] = [];
  const normal: ActiveRepo[] = [];
  const archived: ArchivedRepo[] = [];
  for (const r of repos) {
    if (isArchived(r)) archived.push(r);
    else if (r.pinned) pinned.push(r);
    else normal.push(r);
  }
  return { pinned, normal, archived };
}

/**
 * dragged を target の直前/直後へ移動した新しい平坦な全 id 列を返す。
 * セクションを跨ぐ移動 / 自分自身への移動 / 未知の id は無効として null を返す。
 */
export function moveWithinSection(
  repos: Repo[],
  draggedId: string,
  targetId: string,
  position: 'before' | 'after',
): string[] | null {
  if (draggedId === targetId) return null;
  const dragged = repos.find((r) => r.id === draggedId);
  const target = repos.find((r) => r.id === targetId);
  if (!dragged || !target) return null;
  if (sectionOf(dragged) !== sectionOf(target)) return null;

  const ids = repos.map((r) => r.id);
  const fromIndex = ids.indexOf(draggedId);
  ids.splice(fromIndex, 1);
  let toIndex = ids.indexOf(targetId);
  if (position === 'after') toIndex += 1;
  ids.splice(toIndex, 0, draggedId);
  return ids;
}

/**
 * 自セクション内で 1 つ前/後ろへ移動した新しい平坦な全 id 列を返す。
 * セクションの端なら null (右クリックメニューの「上へ移動」/「下へ移動」の disabled 判定にそのまま使える)。
 */
export function moveByOffset(repos: Repo[], id: string, delta: -1 | 1): string[] | null {
  const repo = repos.find((r) => r.id === id);
  if (!repo) return null;
  const section = sectionOf(repo);
  const sectionIds = repos.filter((r) => sectionOf(r) === section).map((r) => r.id);
  const index = sectionIds.indexOf(id);
  const neighborIndex = index + delta;
  if (neighborIndex < 0 || neighborIndex >= sectionIds.length) return null;
  const neighborId = sectionIds[neighborIndex];
  return moveWithinSection(repos, id, neighborId, delta < 0 ? 'before' : 'after');
}

/**
 * `PUT /api/repos/order` / `PATCH /api/repos/:id` のレスポンス (`RepoMeta[]`、確定順) を
 * ローカルの `repos` に適用する。meta の順序に並べ替え、フラグを反映する。
 * - ローカルに無い meta id は無視する
 * - meta に無いローカルの repo は結果から除去する
 * - アクティブ → アーカイブはローカルで変換できる (`knownWorktreePaths: []` にする)
 * - アーカイブ → アクティブは git 由来データ (worktrees/gitMode/error) を捏造できないため、
 *   その repo を結果に含めず `needsRefresh: true` を返す (呼び出し側が `refresh()` する)。
 *   ピン状態だけの変化は `needsRefresh: false`
 */
export function applyRepoMeta(repos: Repo[], meta: RepoMeta[]): { repos: Repo[]; needsRefresh: boolean } {
  const byId = new Map(repos.map((r) => [r.id, r]));
  let needsRefresh = false;
  const result: Repo[] = [];
  for (const m of meta) {
    const current = byId.get(m.id);
    if (!current) continue; // ローカルに無い meta id は無視
    if (m.archived) {
      if (isArchived(current)) {
        result.push(current);
      } else {
        result.push({
          id: current.id,
          path: current.path,
          name: current.name,
          pinned: false,
          archived: true,
          knownWorktreePaths: [],
        });
      }
    } else if (isActive(current)) {
      result.push({ ...current, pinned: m.pinned });
    } else {
      // アーカイブ → アクティブ。worktrees/gitMode/error は git を実行しないと得られない。
      needsRefresh = true;
    }
  }
  return { repos: result, needsRefresh };
}
