import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import fuzzysort from 'fuzzysort';
import { getCachedFileList, refreshFileList, type QuickOpenTarget } from '../search/fileListCache';
import type { FilesTabHandle } from '../search/registry';
import { fileIcon } from './FileTree';

const LIMIT = 50;

interface Item {
  rel: string;
  nameIndexes?: readonly number[]; // highlight indexes within the basename
  pathIndexes?: readonly number[]; // highlight indexes within the full path
  open?: boolean; // currently open as an editor tab
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** Wrap the characters at `indexes` in <mark>. */
function highlightIndexes(text: string, indexes: ReadonlySet<number>): ReactNode[] {
  if (indexes.size === 0) return [text];
  const parts: ReactNode[] = [];
  let plain = '';
  for (let i = 0; i < text.length; i++) {
    if (indexes.has(i)) {
      if (plain) {
        parts.push(plain);
        plain = '';
      }
      parts.push(
        <mark className="fuzzy-hl" key={i}>
          {text[i]}
        </mark>,
      );
    } else {
      plain += text[i];
    }
  }
  if (plain) parts.push(plain);
  return parts;
}

/**
 * Ctrl+P Quick Open: fuzzy file name search over the target worktree.
 * Stale-while-revalidate — the cached list renders instantly, a background
 * refetch swaps in fresh data.
 */
export default function QuickOpenModal({
  target,
  onClose,
}: {
  target: FilesTabHandle;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [entry, setEntry] = useState(() => getCachedFileList(target.root));
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    refreshFileList(target.root)
      .then((e) => {
        if (alive) setEntry(e);
      })
      .catch(() => {
        // keep the stale list; opening a deleted file surfaces its own error
      });
    return () => {
      alive = false;
    };
  }, [target.root]);

  const items = useMemo<Item[]>(() => {
    const targets = entry?.targets ?? [];
    if (!query) {
      const open = target.getOpenTabPaths();
      const openSet = new Set(open);
      const rest = targets.filter((t) => !openSet.has(t.rel)).slice(0, Math.max(0, LIMIT - open.length));
      return [...open.map((rel) => ({ rel, open: true })), ...rest.map((t) => ({ rel: t.rel }))];
    }
    const results = fuzzysort.go<QuickOpenTarget>(query, targets, {
      keys: ['name', 'path'],
      limit: LIMIT,
    });
    return results.map((r) => ({
      rel: r.obj.rel,
      nameIndexes: r[0]?.indexes ?? [],
      pathIndexes: r[1]?.indexes ?? [],
    }));
  }, [entry, query, target]);

  useEffect(() => setSelected(0), [items]);

  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const openItem = (item: Item | undefined) => {
    if (!item) return;
    target.openFile(item.rel);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length === 0) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setSelected((s) => (s + delta + items.length) % items.length);
    } else if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME confirm
      openItem(items[selected]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div className="quickopen-backdrop" onClick={onClose}>
      <div className="quickopen" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="quickopen-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="ファイル名で検索"
          autoFocus
          spellCheck={false}
        />
        <div className="quickopen-list" ref={listRef}>
          {!entry && <div className="quickopen-empty">読み込み中...</div>}
          {entry && items.length === 0 && (
            <div className="quickopen-empty">ファイルが見つかりません</div>
          )}
          {items.map((item, i) => {
            const name = basename(item.rel);
            const dirLen = item.rel.length - name.length; // includes the trailing '/'
            const { icon, color } = fileIcon(name);
            // Path-key matches inside the basename portion fold into the name
            // highlights; the rest highlight the dim directory segment.
            const nameHl = new Set(item.nameIndexes ?? []);
            const dirHl = new Set<number>();
            for (const idx of item.pathIndexes ?? []) {
              if (idx >= dirLen) nameHl.add(idx - dirLen);
              else dirHl.add(idx);
            }
            return (
              <Fragment key={item.rel}>
                {!query && item.open && i === 0 && (
                  <div className="quickopen-section">開いているファイル</div>
                )}
                {!query && !item.open && items[i - 1]?.open && (
                  <div className="quickopen-section">ファイル</div>
                )}
                <div
                  className={`quickopen-item ${i === selected ? 'selected' : ''}`}
                  onClick={() => openItem(item)}
                  onMouseEnter={() => setSelected(i)}
                  title={item.rel}
                >
                  <span className={`codicon codicon-${icon} quickopen-item-icon`} style={{ color }} />
                  <span className="quickopen-item-name">{highlightIndexes(name, nameHl)}</span>
                  {dirLen > 0 && (
                    <span className="quickopen-item-dir">
                      {highlightIndexes(item.rel.slice(0, dirLen - 1), dirHl)}
                    </span>
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
