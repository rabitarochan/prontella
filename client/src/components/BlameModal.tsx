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
import type { BlameLine, BlameResult } from '../types';

const ZERO_HASH = '0'.repeat(40);

function formatAuthorTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString('ja-JP');
}

/**
 * 1 行分の左側注釈 (hash 短縮 + author) を出すべきかどうか。直前の行と同一コミットが
 * 連続するときは注釈を繰り返さない(先頭行だけ出す)— FileHistoryModal 一覧のような
 * 反復情報の間引きと同じ考え方。読みやすさのための任意の間引きであり、データとしては
 * 全行が commit 情報を持つ(BlameLine は毎行完全)。
 */
function isRunStart(lines: BlameLine[], i: number): boolean {
  return i === 0 || lines[i - 1].hash !== lines[i].hash;
}

/**
 * ファイルツリーの「blame...」から開く読み取り専用モーダル。各行の左に最後にその行を変更した
 * コミットの短縮 hash + author、右に行内容を表示する(`git blame --porcelain`, 6.5)。
 *
 * Monaco は使わない — StashDiffPane (6 系) と同じ理由で、既知債務 "TextModel got disposed" を
 * 新たに踏む経路を増やさないためのプレーンテキスト表示(構造的な回避方針、Phase 6 で確立)。
 * 常に読み取り専用(blame 自体が git の読み取り専用コマンドであり、index/worktree への操作は
 * 一切出さない)。
 */
export default function BlameModal({
  dir,
  path,
  onClose,
}: {
  dir: string;
  path: string;
  onClose: () => void;
}) {
  const [result, setResult] = useState<BlameResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setResult(null);
    setError('');
    api
      .blame(dir, path)
      .then(setResult)
      .catch((e: Error) => setError(e.message));
  }, [dir, path]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[640px] max-h-[88vh] w-[92vw] flex-col sm:max-w-[900px]">
        <DialogHeader>
          <DialogTitle className="truncate pr-6" title={path}>
            blame — {path}
          </DialogTitle>
        </DialogHeader>
        {error ? (
          <div className="placeholder">⚠ {error}</div>
        ) : result === null ? (
          <div className="placeholder">読み込み中...</div>
        ) : result.binary ? (
          <div className="placeholder">バイナリファイルの blame は表示できません</div>
        ) : result.tooLarge ? (
          // files.ts の MAX_FILE_SIZE と同じ閾値(2MB)。エディターが開けないファイルを
          // blame では丸ごと読めてしまう非対称を避けるためのガード(6.5R R-3)。
          <div className="placeholder">ファイルが大きすぎます(2MB を超えています)</div>
        ) : result.notFound ? (
          // 未追跡ファイル等、blame 対象の履歴が無いケース。「ファイルの履歴...」
          // (FileHistoryModal)の同状況での文言に揃える(6.5R R-4、対称性の基準)。
          <div className="placeholder">このファイルのコミット履歴はありません</div>
        ) : result.lines.length === 0 ? (
          <div className="placeholder">空のファイルです</div>
        ) : (
          <div className="blame-body">
            {result.lines.map((l, i) => {
              const uncommitted = l.hash === ZERO_HASH;
              const showAnnotation = isRunStart(result.lines, i);
              return (
                <div key={i} className={`blame-row ${uncommitted ? 'blame-row-uncommitted' : ''}`}>
                  <span className="blame-line-no">{l.line}</span>
                  {showAnnotation ? (
                    <span
                      className="blame-annotation"
                      title={`${uncommitted ? '未コミットの変更' : l.hash}\n${l.summary}\n${l.author} — ${formatAuthorTime(l.authorTime)}`}
                    >
                      <span className="blame-hash">{uncommitted ? '未コミット' : l.hash.slice(0, 7)}</span>
                      <span className="blame-author">{l.author}</span>
                    </span>
                  ) : (
                    <span className="blame-annotation blame-annotation-repeat" />
                  )}
                  <span className="blame-content">{l.content || ' '}</span>
                </div>
              );
            })}
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
