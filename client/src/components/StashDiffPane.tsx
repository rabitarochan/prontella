import { useEffect, useState } from 'react';
import { api } from '../api';
import { classifyDiffLine, truncateStashDiffText } from '../stashDiffText';

/**
 * スタッシュの中身 (`git stash show -p`) を読み取り専用のプレーンテキストとして表示する。
 * DiffPane (Monaco DiffEditor) とは異なり、複数ファイルにまたがる 1 本の unified diff
 * テキストをそのまま表示するだけなので、Monaco は使わない (Phase 1/2 由来の既知債務
 * 「Monaco "TextModel got disposed"」を新たに踏む経路を増やさないための意図的な選択)。
 * ハンク単位の stage/unstage/discard 操作は一切出さない (このタブは常に読み取り専用)。
 */
export default function StashDiffPane({ dir, stashRef }: { dir: string; stashRef: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setText(null);
    setError('');
    api
      .stashShow(dir, stashRef)
      .then(({ text }) => setText(text))
      .catch((e: Error) => setError(e.message));
  }, [dir, stashRef]);

  if (error) return <div className="placeholder">⚠ {error}</div>;
  if (text === null) return <div className="placeholder">読み込み中...</div>;
  if (!text) return <div className="placeholder">差分はありません (tracked な変更なし)</div>;

  // files.ts の MAX_FILE_SIZE と同じ閾値 (2MB、BlameModal 参照)。BlameModal は上限超過を
  // 全く表示しないが、ここは複数ファイルにまたがる 1 本のテキストなので、切り詰めた分まで
  // 表示しつつ末尾に省略の通知を出す (詳細は stashDiffText.ts の truncateStashDiffText)。
  const { text: shownText, truncated } = truncateStashDiffText(text);

  return (
    <div className="stash-diff-text">
      {shownText.split('\n').map((line, i) => (
        <div key={i} className={`sdiff-line sdiff-${classifyDiffLine(line)}`}>
          {line || ' '}
        </div>
      ))}
      {truncated && (
        <div className="sdiff-truncated">⚠ 差分が大きすぎるため以降を省略しています (2MB を超えています)</div>
      )}
    </div>
  );
}
