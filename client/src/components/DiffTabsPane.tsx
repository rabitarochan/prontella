import type { StatusFile } from '../types';
import ConflictResolvePane from './ConflictResolvePane';
import DiffPane from './DiffPane';
import StashDiffPane from './StashDiffPane';

/**
 * 変更リストで選択したファイルの左右 diff (+ 競合ファイルの解決) をタブで並べるペイン。
 * ワークスペース/変更リストと違い、ここだけがタブ化される。
 * ページはマウントしたまま display で切り替え (スクロール位置保持)。
 * 内容は開いた時点のもの — 同じ行の再クリック・↻・サイドバー操作
 * (reloadKey) で取り直す。
 *
 * 競合タブ (kind: 'conflict') は編集可能な状態を保持するステートフルなタブなので、
 * diff タブと違って gen/reloadKey で強制再マウントはしない (サイドバーの無関係な操作の
 * たびに未保存の解決作業が消えるのを避けるため)。ConflictResolvePane 自身が
 * onResolved で必要な再読込をトリガーする。
 */

export interface DiffTab {
  kind: 'diff';
  key: string; // `${'s'|'w'}:${path}`
  path: string;
  origPath: string | null;
  staged: boolean;
  /** untracked ファイルの合成 diff か (DiffPane 側でハンク操作を出さない判定に使う) */
  untracked: boolean;
  gen: number; // 増やすと再フェッチ
}

export interface ConflictTab {
  kind: 'conflict';
  key: string; // `c:${path}`
  path: string;
}

export interface StashTab {
  kind: 'stash';
  key: string; // `sd:${ref}`
  ref: string; // e.g. "stash@{0}"
  message: string;
}

export type WorkTab = DiffTab | ConflictTab | StashTab;

export function diffTabKey(file: StatusFile, staged: boolean): string {
  return `${staged ? 's' : 'w'}:${file.path}`;
}

export function conflictTabKey(path: string): string {
  return `c:${path}`;
}

export function stashTabKey(ref: string): string {
  return `sd:${ref}`;
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export default function DiffTabsPane({
  dir,
  tabs,
  activeKey,
  reloadKey,
  onActivate,
  onClose,
  onReload,
  onStatusChanged,
}: {
  dir: string;
  tabs: WorkTab[];
  activeKey: string | null;
  /** サイドバー操作 (コミット/ブランチ切替等) 後に全 diff を取り直すためのキー */
  reloadKey: number;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onReload: (key: string) => void;
  /** 競合解決 (全体採用/解決済み) が成功した後に呼ばれる。branches/stashes/operation の
   *  再取得や worktree.status の更新など、GitTab 側の「status 更新」をトリガーする。 */
  onStatusChanged?: () => void;
}) {
  // ハンク操作 (stage/unstage/discard) や競合解決が成功したタブ (sourceKey) と同じ
  // ファイルを別スコープ/別タブで開いている兄弟タブがあれば、diff タブなら既存の
  // 「差分を取り直す」と同じ経路 (onReload → gen++ → DiffPane の key が変わって再マウント)
  // で再読込させる。競合タブは gen を持たない (DiffTabsPane 冒頭コメント参照) ため対象外。
  // 操作した本人のタブは呼び出し元で既に更新済みなので除外する。
  const notifySiblings = (path: string, sourceKey: string) => {
    for (const t of tabs) {
      // StashTab は path を持たないため、t.kind === 'diff' を先に見て絞り込んでから t.path
      // にアクセスする (TS の型絞り込みは論理式を左から評価するため、絞り込み前の t.path
      // 参照は StashTab に存在しないプロパティとしてコンパイルエラーになる)。
      if (t.kind === 'diff' && t.key !== sourceKey && t.path === path) onReload(t.key);
    }
  };

  return (
    <div className="git-file-tabs">
      {tabs.length === 0 ? (
        <div className="placeholder">ファイルを選択すると差分をタブで表示します</div>
      ) : (
        <>
          <div className="editor-tabs">
            {tabs.map((t) => (
              <div
                key={t.key}
                className={`editor-tab ${activeKey === t.key ? 'active' : ''}`}
                title={
                  t.kind === 'diff'
                    ? `${t.path}${t.staged ? ' (ステージ済みの変更)' : ''}`
                    : t.kind === 'conflict'
                      ? `${t.path} (競合の解決)`
                      : `${t.ref}: ${t.message}`
                }
                onClick={() => onActivate(t.key)}
              >
                <span
                  className={`codicon codicon-${t.kind === 'diff' ? 'diff' : t.kind === 'conflict' ? 'warning' : 'archive'}`}
                />
                <span className="editor-tab-name">
                  {t.kind === 'stash' ? t.message || t.ref : basename(t.path)}
                  {t.kind === 'diff' && t.staged && <span className="diff-tab-staged"> S</span>}
                </span>
                <span className="editor-tab-actions">
                  <button
                    className="editor-tab-close"
                    title="閉じる"
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(t.key);
                    }}
                  >
                    <span className="codicon codicon-close" />
                  </button>
                </span>
              </div>
            ))}
          </div>
          {tabs.map((t) => (
            <div
              key={t.key}
              className="diff-page"
              style={{ display: activeKey === t.key ? undefined : 'none' }}
            >
              {t.kind === 'diff' ? (
                <>
                  <div className="diff-toolbar">
                    <span className="diff-path" title={t.path}>
                      {t.path}
                    </span>
                    <span className="diff-scope">
                      {t.staged
                        ? 'ステージ済みの変更 (HEAD ↔ インデックス)'
                        : '未ステージの変更 (インデックス ↔ 作業ツリー)'}
                    </span>
                    <button className="icon-btn" title="差分を取り直す" onClick={() => onReload(t.key)}>
                      <span className="codicon codicon-refresh" />
                    </button>
                  </div>
                  <div className="diff-body">
                    <DiffPane
                      key={`${t.gen}:${reloadKey}`}
                      dir={dir}
                      path={t.path}
                      scope={t.staged ? 'staged' : 'worktree'}
                      origPath={t.origPath}
                      untracked={t.untracked}
                      onHunksChanged={() => notifySiblings(t.path, t.key)}
                    />
                  </div>
                </>
              ) : t.kind === 'conflict' ? (
                <ConflictResolvePane
                  dir={dir}
                  path={t.path}
                  onResolved={() => {
                    notifySiblings(t.path, t.key);
                    onStatusChanged?.();
                  }}
                />
              ) : (
                <>
                  <div className="diff-toolbar">
                    <span className="diff-path" title={t.ref}>
                      {t.message || t.ref}
                    </span>
                    <span className="diff-scope">スタッシュの差分 (読み取り専用)</span>
                  </div>
                  <div className="diff-body">
                    <StashDiffPane dir={dir} stashRef={t.ref} />
                  </div>
                </>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
