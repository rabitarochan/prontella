import type { StatusFile } from '../types';
import DiffPane from './DiffPane';

/**
 * 変更リストで選択したファイルの左右 diff をタブで並べるペイン。
 * ワークスペース/変更リストと違い、ここだけがタブ化される。
 * ページはマウントしたまま display で切り替え (スクロール位置保持)。
 * 内容は開いた時点のもの — 同じ行の再クリック・↻・サイドバー操作
 * (reloadKey) で取り直す。
 */

export interface DiffTab {
  key: string; // `${'s'|'w'}:${path}`
  path: string;
  origPath: string | null;
  staged: boolean;
  gen: number; // 増やすと再フェッチ
}

export function diffTabKey(file: StatusFile, staged: boolean): string {
  return `${staged ? 's' : 'w'}:${file.path}`;
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
}: {
  dir: string;
  tabs: DiffTab[];
  activeKey: string | null;
  /** サイドバー操作 (コミット/ブランチ切替等) 後に全 diff を取り直すためのキー */
  reloadKey: number;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onReload: (key: string) => void;
}) {
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
                title={`${t.path}${t.staged ? ' (ステージ済みの変更)' : ''}`}
                onClick={() => onActivate(t.key)}
              >
                <span className="codicon codicon-diff" />
                <span className="editor-tab-name">
                  {basename(t.path)}
                  {t.staged && <span className="diff-tab-staged"> S</span>}
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
              <div className="diff-toolbar">
                <span className="diff-path" title={t.path}>
                  {t.path}
                </span>
                <span className="diff-scope">
                  {t.staged ? 'ステージ済みの変更 (HEAD ↔ インデックス)' : '未ステージの変更 (インデックス ↔ 作業ツリー)'}
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
                />
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
