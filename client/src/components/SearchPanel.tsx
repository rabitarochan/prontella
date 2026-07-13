import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import type { SearchTextResponse } from '../types';
import { fileIcon } from './FileTree';

const DEBOUNCE_MS = 200;

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** Render a match preview with <mark> highlights, leading whitespace trimmed. */
function highlightPreview(preview: string, ranges: [number, number][]): ReactNode[] {
  const lead = preview.length - preview.trimStart().length;
  const text = preview.slice(lead);
  const parts: ReactNode[] = [];
  let pos = 0;
  ranges.forEach(([start, end], i) => {
    const s = Math.max(0, start - lead);
    const e = Math.max(0, end - lead);
    if (e <= s) return;
    if (s > pos) parts.push(text.slice(pos, s));
    parts.push(
      <mark className="search-hl" key={i}>
        {text.slice(s, e)}
      </mark>,
    );
    pos = e;
  });
  if (pos < text.length) parts.push(text.slice(pos));
  return parts;
}

/**
 * Ctrl+Shift+F text search over the worktree, shown in place of the file
 * tree. Stays mounted once visited so query and results survive switching
 * back to the tree.
 */
export default function SearchPanel({
  root,
  visible,
  focusSeq,
  onJump,
  onClose,
}: {
  root: string;
  visible: boolean;
  focusSeq: number;
  onJump: (path: string, line: number, column: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [data, setData] = useState<SearchTextResponse | null>(null);
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0); // discards responses that lost the race
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!visible) return;
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, [visible, focusSeq]);

  const runSearch = (q: string) => {
    abortRef.current?.abort();
    const seq = ++seqRef.current;
    if (!q) {
      setData(null);
      setError('');
      setSearching(false);
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setSearching(true);
    api
      .searchText(root, q, { regex: useRegex, caseSensitive }, ctrl.signal)
      .then((res) => {
        if (seq !== seqRef.current) return;
        setData(res);
        setError('');
        setCollapsed(new Set());
        setSearching(false);
      })
      .catch((e: unknown) => {
        if (seq !== seqRef.current) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        // e.g. a regex typed mid-edit — show the error, keep previous results
        setError(e instanceof Error ? e.message : String(e));
        setSearching(false);
      });
  };

  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    if (!query) {
      runSearch('');
      return;
    }
    timerRef.current = window.setTimeout(() => runSearch(query), DEBOUNCE_MS);
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [query, useRegex, caseSensitive, root]);

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !(e.nativeEvent.isComposing || e.keyCode === 229)) {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      runSearch(query); // flush the debounce
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  const toggleCollapse = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="search-panel">
      <div className="search-input-row">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="検索"
          spellCheck={false}
        />
        <button
          className={`search-toggle ${caseSensitive ? 'active' : ''}`}
          title="大文字と小文字を区別"
          onClick={() => setCaseSensitive((v) => !v)}
        >
          Aa
        </button>
        <button
          className={`search-toggle ${useRegex ? 'active' : ''}`}
          title="正規表現を使用"
          onClick={() => setUseRegex((v) => !v)}
        >
          .*
        </button>
      </div>
      {error && <div className="search-error">⚠ {error}</div>}
      {data && (
        <div className="search-summary">
          {data.fileCount} ファイル / {data.matchCount} 件{searching && ' …'}
          {data.limitHit && <span className="search-limit">(上限に達したため一部のみ表示)</span>}
        </div>
      )}
      <div className="search-results">
        {data?.results.length === 0 && !searching && (
          <div className="search-empty">結果がありません</div>
        )}
        {data?.results.map((file) => {
          const name = basename(file.path);
          const dir = dirname(file.path);
          const { icon, color } = fileIcon(name);
          const isCollapsed = collapsed.has(file.path);
          return (
            <div className="search-file-group" key={file.path}>
              <div className="search-file-header" onClick={() => toggleCollapse(file.path)}>
                <span
                  className={`codicon codicon-chevron-right search-chevron ${isCollapsed ? '' : 'open'}`}
                />
                <span className={`codicon codicon-${icon} search-file-icon`} style={{ color }} />
                <span className="search-file-name" title={file.path}>
                  {name}
                </span>
                {dir && <span className="search-file-dir">{dir}</span>}
                <span className="search-file-count">{file.matches.length}</span>
              </div>
              {!isCollapsed &&
                file.matches.map((m, i) => (
                  <div
                    className="search-match-row"
                    key={`${m.line}:${m.column}:${i}`}
                    onClick={() => onJump(file.path, m.line, m.column)}
                    title={`${file.path}:${m.line}`}
                  >
                    <span className="search-line-no">{m.line}</span>
                    <span className="search-match-preview">
                      {highlightPreview(m.preview, m.ranges)}
                    </span>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
