import { useEffect, useState } from 'react';
import { SquareArrowOutUpRight } from 'lucide-react';
import { api } from '../api';
import { useT } from '../i18n';

/**
 * ワークツリーをネイティブのエディター (既定は VS Code) で開くボタン。
 *
 * ブラウザーに埋め込む方式では越えられない壁が 2 つある (どちらも実測):
 * ブラウザーがキーバインドを奪う (F5 がページ再読み込みになる等) ことと、
 * web workbench のユーザー設定・キーバインドがブラウザーの IndexedDB に入り
 * デスクトップのプロファイルと繋がらないこと。ネイティブに渡せば何も失わない。
 *
 * エディターが見つからない環境ではボタンごと出さない (押せない物を置かない)。
 * 判定はプロセスで一度だけ問い合わせて共有する。
 */
let probe: Promise<boolean> | null = null;

function editorAvailable(): Promise<boolean> {
  probe ??= api
    .editorStatus()
    .then((s) => s.available)
    .catch(() => false);
  return probe;
}

export default function OpenInEditorButton({ dir }: { dir: string }) {
  const t = useT();
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void editorAvailable().then((ok) => {
      if (alive) setAvailable(ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!available) return null;

  const open = () => {
    setBusy(true);
    setError('');
    api
      .openInEditor(dir)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <button
      className="icon-btn"
      title={error || t('wt.openInEditor')}
      disabled={busy}
      onClick={open}
    >
      <SquareArrowOutUpRight />
    </button>
  );
}
