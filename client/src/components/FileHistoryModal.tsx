import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api } from '../api';
import type { LogEntry } from '../types';
import DiffPane from './DiffPane';

const LIMIT = 200;

/**
 * ファイルツリーの「ファイルの履歴...」から開く読み取り専用モーダル。左にそのファイルの
 * コミット一覧 (`git log --follow`, 6.3)、右に選択コミット時点の diff (DiffPane
 * scope="commit" — HistoryTab の commitFiles 選択と同じ経路)。
 *
 * リネーム対応: --follow は当該コミット時点での実パスを LogEntry.path/origPath として
 * 返す (server/git.ts の getLog 参照)。リネームコミットの diff は origPath (親コミット
 * 時点の旧パス) を渡さないと親コミットに現在パスが存在せず空 diff / 誤った「新規ファイル」
 * 表示になる (実 git で確認済み) — DiffPane へは常に selected.path/selected.origPath を渡す。
 * マージコミットは (name-status 行が出ないため) 一覧から除外される — リニアな追跡が目的の
 * ファイル履歴のスコープ外として明示的に見送り (6.3 の既知の制限)。
 */
export default function FileHistoryModal({
  dir,
  path,
  onClose,
}: {
  dir: string;
  path: string;
  onClose: () => void;
}) {
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<LogEntry | null>(null);

  useEffect(() => {
    setLog(null);
    setError('');
    setSelected(null);
    api
      .log(dir, LIMIT, false, { path, follow: true })
      .then((entries) => {
        setLog(entries);
        if (entries.length > 0) setSelected(entries[0]);
      })
      .catch((e: Error) => setError(e.message));
  }, [dir, path]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[640px] max-h-[88vh] w-[92vw] flex-col sm:max-w-[900px]">
        <DialogHeader>
          <DialogTitle className="truncate pr-6" title={path}>
            ファイルの履歴 — {path}
          </DialogTitle>
        </DialogHeader>
        {error ? (
          <div className="placeholder">⚠ {error}</div>
        ) : (
          <div className="file-history-body">
            <div className="file-history-list">
              {log === null ? (
                <div className="placeholder">読み込み中...</div>
              ) : log.length === 0 ? (
                <div className="placeholder">このファイルのコミット履歴はありません</div>
              ) : (
                log.map((entry) => (
                  <div
                    key={entry.hash}
                    className={`file-history-row ${selected?.hash === entry.hash ? 'selected' : ''}`}
                    onClick={() => setSelected(entry)}
                    title={entry.subject}
                  >
                    <div className="file-history-row-top">
                      <span className="log-hash">{entry.shortHash}</span>
                      <span className="file-history-date">
                        {new Date(entry.date).toLocaleDateString('ja-JP')}
                      </span>
                    </div>
                    <div className="file-history-subject">{entry.subject}</div>
                    <div className="file-history-author">{entry.author}</div>
                    {entry.origPath && (
                      <div
                        className="file-history-rename"
                        title={`${entry.origPath} → ${entry.path}`}
                      >
                        リネーム: {entry.origPath} → {entry.path}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
            <div className="file-history-diff">
              {!selected ? (
                <div className="placeholder">コミットを選択すると差分を表示します</div>
              ) : (
                <DiffPane
                  dir={dir}
                  path={selected.path ?? path}
                  scope="commit"
                  hash={selected.hash}
                  origPath={selected.origPath ?? null}
                />
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            閉じる
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
