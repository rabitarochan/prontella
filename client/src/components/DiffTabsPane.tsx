import { useT } from '../i18n';
import type { StatusFile } from '../types';
import ConflictResolvePane from './ConflictResolvePane';
import DiffPane from './DiffPane';
import { middleClickAutoscrollGuard, middleClickClose } from './editorTabs';
import StashDiffPane from './StashDiffPane';

/**
 * 変更リストで選択したファイルの左右 diff (+ 競合ファイルの解決) をタブで並べるペイン。
 * ワークスペース/変更リストと違い、ここだけがタブ化される。
 *
 * diff/stash タブは読み取り専用でマウント時に再フェッチする設計なので、非アクティブな
 * タブは DOM ごとアンマウントする (display:none での常時マウントはしない)。タブ数だけ
 * Monaco DiffEditor が常駐して長時間セッションを劣化させていた問題への対処。
 * タブ切替のたびに再フェッチが起きるのは意図した挙動 (むしろ内容が新鮮になる)。
 * スクロール位置は切替のたびにリセットされる (許容されたトレードオフ)。
 *
 * 競合タブ (kind: 'conflict') だけは例外で、編集可能な状態を保持するステートフルな
 * タブなので、非アクティブでもアンマウントせず display:none で隠したまま維持する
 * (アンマウントすると未保存の解決作業が消えるため)。gen/reloadKey による強制再マウントも
 * 競合タブには効かせない (ConflictResolvePane 自身が onResolved で必要な再読込をトリガーする)。
 * ただし GitTab の view を history タブへ切り替えると DiffTabsPane ごと unmount されるため、
 * その場合は競合タブでも未保存の解決作業は失われる (既知の既存挙動、ここでの対処範囲外)。
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
  leafId,
  tabs,
  activeKey,
  reloadKey,
  onActivate,
  onClose,
  onReload,
  onStatusChanged,
}: {
  dir: string;
  /** タイルの leaf id。ConflictResolvePane の Monaco モデル名前空間に渡す。 */
  leafId: string;
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
  const t = useT();
  // ハンク操作 (stage/unstage/discard) や競合解決が成功したタブ (sourceKey) と同じ
  // ファイルを別スコープ/別タブで開いている兄弟タブがあれば、diff タブなら既存の
  // 「差分を取り直す」と同じ経路 (onReload → gen++ → DiffPane の key が変わって再マウント)
  // で再読込させる。競合タブは gen を持たない (DiffTabsPane 冒頭コメント参照) ため対象外。
  // 操作した本人のタブは呼び出し元で既に更新済みなので除外する。
  // gen は非アクティブタブの再マウント方式に切り替えた後も削除できない: 競合解決の
  // await 中にユーザーがタブを切り替えて sourceKey とは別の diff タブがアクティブ (=既に
  // マウント済み) になっているケースでは、単に「マウントされている」だけでは古い内容の
  // ままなので、gen++ で key を変えて明示的に再マウント/再フェッチさせる必要がある。
  const notifySiblings = (path: string, sourceKey: string) => {
    for (const tab of tabs) {
      // StashTab は path を持たないため、tab.kind === 'diff' を先に見て絞り込んでから tab.path
      // にアクセスする (TS の型絞り込みは論理式を左から評価するため、絞り込み前の tab.path
      // 参照は StashTab に存在しないプロパティとしてコンパイルエラーになる)。
      if (tab.kind === 'diff' && tab.key !== sourceKey && tab.path === path) onReload(tab.key);
    }
  };

  return (
    <div className="git-file-tabs">
      {tabs.length === 0 ? (
        <div className="placeholder">{t('difftabs.empty')}</div>
      ) : (
        <>
          <div className="editor-tabs" {...middleClickAutoscrollGuard}>
            {tabs.map((tab) => (
              <div
                key={tab.key}
                className={`editor-tab ${activeKey === tab.key ? 'active' : ''}`}
                title={
                  tab.kind === 'diff'
                    ? `${tab.path}${tab.staged ? t('difftabs.titleStaged') : ''}`
                    : tab.kind === 'conflict'
                      ? `${tab.path}${t('difftabs.titleConflict')}`
                      : `${tab.ref}: ${tab.message}`
                }
                onClick={() => onActivate(tab.key)}
                {...middleClickClose(() => onClose(tab.key))}
              >
                <span
                  className={`codicon codicon-${tab.kind === 'diff' ? 'diff' : tab.kind === 'conflict' ? 'warning' : 'archive'}`}
                />
                <span className="editor-tab-name">
                  {tab.kind === 'stash' ? tab.message || tab.ref : basename(tab.path)}
                  {tab.kind === 'diff' && tab.staged && <span className="diff-tab-staged"> S</span>}
                </span>
                <span className="editor-tab-actions">
                  <button
                    className="editor-tab-close"
                    title={t('common.close')}
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(tab.key);
                    }}
                  >
                    <span className="codicon codicon-close" />
                  </button>
                </span>
              </div>
            ))}
          </div>
          {tabs.map((tab) => {
            // 競合タブは編集途中の状態を保持するステートフルなタブなので、非アクティブ時も
            // アンマウントせず display:none で隠す (冒頭コメント参照)。diff/stash タブは
            // 読み取り専用でマウント時に再フェッチする設計なので、非アクティブなら
            // DOM ごと作らない (Monaco DiffEditor / ResizeObserver をタブ数だけ常駐させない)。
            if (tab.kind === 'conflict') {
              return (
                <div
                  key={tab.key}
                  className="diff-page"
                  style={{ display: activeKey === tab.key ? undefined : 'none' }}
                >
                  <ConflictResolvePane
                    dir={dir}
                    leafId={leafId}
                    path={tab.path}
                    onResolved={() => {
                      notifySiblings(tab.path, tab.key);
                      onStatusChanged?.();
                    }}
                  />
                </div>
              );
            }
            if (activeKey !== tab.key) return null;
            return (
              <div key={tab.key} className="diff-page">
                {tab.kind === 'diff' ? (
                  <>
                    <div className="diff-toolbar">
                      <span className="diff-path" title={tab.path}>
                        {tab.path}
                      </span>
                      <span className="diff-scope">
                        {tab.staged ? t('difftabs.stagedScopeLabel') : t('difftabs.unstagedScopeLabel')}
                      </span>
                      {/* このボタンはアクティブ (= 既にマウント済み) なタブ自身を対象にする。
                          非アクティブタブのアンマウントとは無関係に、gen++ で key を変えて
                          DiffPane を明示的に再マウントさせないと再フェッチが起きない。 */}
                      <button
                        className="icon-btn"
                        title={t('difftabs.reloadTooltip')}
                        onClick={() => onReload(tab.key)}
                      >
                        <span className="codicon codicon-refresh" />
                      </button>
                    </div>
                    <div className="diff-body">
                      <DiffPane
                        key={`${tab.gen}:${reloadKey}`}
                        dir={dir}
                        path={tab.path}
                        scope={tab.staged ? 'staged' : 'worktree'}
                        origPath={tab.origPath}
                        untracked={tab.untracked}
                        onHunksChanged={() => notifySiblings(tab.path, tab.key)}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="diff-toolbar">
                      <span className="diff-path" title={tab.ref}>
                        {tab.message || tab.ref}
                      </span>
                      <span className="diff-scope">{t('difftabs.stashScopeLabel')}</span>
                    </div>
                    <div className="diff-body">
                      <StashDiffPane dir={dir} stashRef={tab.ref} />
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
