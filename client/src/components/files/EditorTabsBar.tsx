// 1 グループ分のファイルタブ列。常にグループ上部にインライン表示する
// (旧 FilesTab はタイルヘッダーへ createPortal していたが、グループ分割で
// グループごとにタブ列が必要になったため廃止。タイルヘッダーはビュータブのみ)。
//
// タブ DnD: 各タブが draggable で、ドラッグ状態は editorTabDnd ストアが正
// (dataTransfer は Firefox 対策のダミー)。ストリップは挿入位置マーカー付きの
// ドロップ先 — 同一グループなら並べ替え、別グループ/別 leaf なら移動になる
// (解決はコーディネーター側)。

import { useRef, useState } from 'react';
import { refKey } from '../../editorState';
import { useT } from '../../i18n';
import { tabInsertionIndex } from '../../layout/dropZones';
import { useEditorTabDnd, type EditorTabDrag } from '../../layout/editorTabDnd';
import { isMarkdownPath } from '../../markdown/paths';
import { basename, middleClickAutoscrollGuard, middleClickClose } from '../editorTabs';
import type { EditorGroup } from './editorGroups';
import { isDirtyEntry, type FileEntry } from './useFileEntries';

export interface TabsBarCallbacks {
  onSwitchTab: (key: string) => void;
  onCloseTab: (key: string) => void;
  onOpenPreview: (path: string) => void;
  onSplit: () => void;
  /** ストリップへのドロップ。index はストリップ上の挿入位置 (ドラッグ元タブ込みの並びに対する)。 */
  onDropTab: (index: number, drag: EditorTabDrag) => void;
}

export default function EditorTabsBar({
  leafId,
  group,
  entries,
  message,
  isActiveGroup,
  callbacks,
}: {
  leafId: string;
  group: EditorGroup;
  entries: Record<string, FileEntry>;
  /** 保存結果等のメッセージ。アクティブグループのバーにだけ出す。 */
  message: string;
  isActiveGroup: boolean;
  callbacks: TabsBarCallbacks;
}) {
  const t = useT();
  const drag = useEditorTabDnd((s) => s.drag);
  const dndStart = useEditorTabDnd((s) => s.start);
  const dndEnd = useEditorTabDnd((s) => s.end);
  const stripRef = useRef<HTMLDivElement>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [markerX, setMarkerX] = useState<number | null>(null);

  const active = group.activeKey ? (entries[group.activeKey] ?? null) : null;
  const showEditorActions =
    active !== null &&
    active.kind !== 'preview' &&
    !active.error &&
    active.file !== null &&
    !active.file.binary &&
    !active.file.tooLarge;

  const clearMarker = () => {
    setDropIndex(null);
    setMarkerX(null);
  };

  const computeInsertion = (clientX: number): { index: number; x: number } | null => {
    const strip = stripRef.current;
    if (!strip) return null;
    const tabs = Array.from(strip.querySelectorAll<HTMLElement>('.editor-tab'));
    const mids = tabs.map((el) => {
      const r = el.getBoundingClientRect();
      return r.left + r.width / 2;
    });
    const index = tabInsertionIndex(mids, clientX);
    const stripRect = strip.getBoundingClientRect();
    const clientEdge =
      index < tabs.length
        ? tabs[index].getBoundingClientRect().left - 2
        : tabs.length > 0
          ? tabs[tabs.length - 1].getBoundingClientRect().right + 2
          : stripRect.left + 4;
    return { index, x: clientEdge - stripRect.left + strip.scrollLeft };
  };

  const onStripDragOver = (e: React.DragEvent) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const ins = computeInsertion(e.clientX);
    if (!ins) return;
    setDropIndex((prev) => (prev === ins.index ? prev : ins.index));
    setMarkerX((prev) => (prev === ins.x ? prev : ins.x));
  };

  const onStripDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const d = drag;
    const index = dropIndex ?? computeInsertion(e.clientX)?.index ?? null;
    clearMarker();
    dndEnd();
    if (d && index !== null) callbacks.onDropTab(index, d);
  };

  return (
    <div className="editor-tabs">
      <div
        className="editor-tabs-strip"
        ref={stripRef}
        {...middleClickAutoscrollGuard}
        onDragOver={onStripDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) clearMarker();
        }}
        onDrop={onStripDrop}
      >
        {group.tabs.map((ref) => {
          const key = refKey(ref);
          const entry = entries[key] ?? null;
          return (
            <div
              key={key}
              className={`editor-tab ${group.activeKey === key ? 'active' : ''} ${
                drag?.key === key && drag.sourceGroupId === group.id ? 'dragging' : ''
              }`}
              title={ref.kind === 'preview' ? t('files.previewTabTitle', { path: ref.path }) : ref.path}
              draggable
              onDragStart={(e) => {
                // dragover 中は getData が読めない (protected mode) ため値は使わないが、
                // Firefox はデータ 0 個だとドラッグ自体を開始しない
                e.dataTransfer.setData('text/plain', key);
                e.dataTransfer.effectAllowed = 'move';
                dndStart({
                  sourceLeafId: leafId,
                  sourceGroupId: group.id,
                  key,
                  kind: ref.kind,
                  path: ref.path,
                });
              }}
              onDragEnd={() => {
                // drop の成否に関わらず dragend は必ず発火する (Esc 中断含む) —
                // ストアの残留はここで確実に防ぐ
                clearMarker();
                dndEnd();
              }}
              onClick={() => callbacks.onSwitchTab(key)}
              {...middleClickClose(() => callbacks.onCloseTab(key))}
            >
              {ref.kind === 'preview' && <span className="codicon codicon-preview" />}
              <span className="editor-tab-name">{basename(ref.path)}</span>
              <span className="editor-tab-actions">
                {isDirtyEntry(entry) && <span className="editor-tab-dirty">●</span>}
                <button
                  className="editor-tab-close"
                  title={t('common.close')}
                  onClick={(e) => {
                    e.stopPropagation();
                    callbacks.onCloseTab(key);
                  }}
                >
                  <span className="codicon codicon-close" />
                </button>
              </span>
            </div>
          );
        })}
        {markerX !== null && (
          <div className="editor-tab-insert-marker" style={{ left: `${markerX}px` }} />
        )}
      </div>
      {/* 保存ボタンは廃止 (Ctrl+S で保存)。保存結果メッセージ・Markdown プレビュー・
          分割ボタンを右端に出す */}
      {isActiveGroup && message && <span className="editor-msg">{message}</span>}
      {showEditorActions && isMarkdownPath(active.path) && (
        <button
          className="icon-btn"
          onClick={() => callbacks.onOpenPreview(active.path)}
          title={t('files.openPreview')}
        >
          <span className="codicon codicon-open-preview" />
        </button>
      )}
      {group.activeKey !== null && (
        <button className="icon-btn" onClick={callbacks.onSplit} title={t('files.splitEditorTooltip')}>
          <span className="codicon codicon-split-horizontal" />
        </button>
      )}
    </div>
  );
}
