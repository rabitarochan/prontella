import { useEffect, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { api } from '../api';
import { languageFor } from '../monaco-setup';
import type { DiffPair } from '../types';

interface DiffPaneProps {
  dir: string;
  path: string;
  scope: 'worktree' | 'staged' | 'commit';
  hash?: string;
  origPath?: string | null;
}

export default function DiffPane({ dir, path, scope, hash, origPath }: DiffPaneProps) {
  const [pair, setPair] = useState<DiffPair | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setPair(null);
    setError('');
    api
      .diffPair(dir, path, scope, { hash, origPath: origPath ?? undefined })
      .then(setPair)
      .catch((e: Error) => setError(e.message));
  }, [dir, path, scope, hash, origPath]);

  if (error) return <div className="placeholder">⚠ {error}</div>;
  if (!pair) return <div className="placeholder">読み込み中...</div>;
  if (pair.binary) return <div className="placeholder">バイナリファイルは差分表示できません</div>;
  if (pair.tooLarge) return <div className="placeholder">ファイルが大きすぎます (2MB 超)</div>;
  if (pair.original === pair.modified) return <div className="placeholder">差分はありません</div>;

  return (
    <DiffEditor
      original={pair.original}
      modified={pair.modified}
      language={languageFor(path)}
      theme="vs-dark"
      options={{
        readOnly: true,
        renderSideBySide: true,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        renderOverviewRuler: false,
        diffWordWrap: 'off',
      }}
    />
  );
}
