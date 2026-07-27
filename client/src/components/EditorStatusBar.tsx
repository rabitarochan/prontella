import { useEffect, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import type { FileContent } from '../types';

type EditorInstance = Parameters<OnMount>[0];

// server/encoding.ts の SUPPORTED_ENCODINGS と一致させる(手動同期)
const ENCODING_LABELS: Record<string, string> = {
  'utf-8': 'UTF-8',
  shift_jis: 'Shift_JIS',
  'euc-jp': 'EUC-JP',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  'windows-1252': 'Windows-1252',
};

const RELOAD_ITEMS = Object.entries(ENCODING_LABELS).map(([encoding, label]) => ({
  encoding,
  label,
}));

// 保存メニューは BOM の有無まで選ばせる(UTF-16 系は慣例どおり常に BOM 付きで書く)
const SAVE_ITEMS: { label: string; encoding: string; bom: boolean }[] = [
  { label: 'UTF-8', encoding: 'utf-8', bom: false },
  { label: 'UTF-8 with BOM', encoding: 'utf-8', bom: true },
  { label: 'Shift_JIS', encoding: 'shift_jis', bom: false },
  { label: 'EUC-JP', encoding: 'euc-jp', bom: false },
  { label: 'UTF-16 LE', encoding: 'utf-16le', bom: true },
  { label: 'UTF-16 BE', encoding: 'utf-16be', bom: true },
  { label: 'Windows-1252', encoding: 'windows-1252', bom: false },
];

const INDENT_CHOICES: { label: string; insertSpaces: boolean; size: number }[] = [
  { label: 'スペース: 2', insertSpaces: true, size: 2 },
  { label: 'スペース: 4', insertSpaces: true, size: 4 },
  { label: 'スペース: 8', insertSpaces: true, size: 8 },
  { label: 'タブ: 2', insertSpaces: false, size: 2 },
  { label: 'タブ: 4', insertSpaces: false, size: 4 },
  { label: 'タブ: 8', insertSpaces: false, size: 8 },
];

function encodingLabel(encoding: string | null, hasBom: boolean): string | null {
  if (!encoding) return null;
  const base = ENCODING_LABELS[encoding] ?? encoding;
  return encoding === 'utf-8' && hasBom ? `${base} with BOM` : base;
}

type MenuKind = 'indent' | 'eol' | 'encoding' | 'encoding-reload' | 'encoding-save';

function MenuItem({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button className="statusbar-menu-item" onClick={onClick}>
      <span
        className="codicon codicon-check"
        style={{ visibility: selected ? 'visible' : 'hidden' }}
      />
      {label}
    </button>
  );
}

export default function EditorStatusBar({
  editor,
  activePath,
  file,
  onReloadWithEncoding,
  onSaveWithEncoding,
  onEolOverride,
}: {
  editor: EditorInstance | null;
  activePath: string;
  file: FileContent;
  onReloadWithEncoding: (encoding: string) => void;
  onSaveWithEncoding: (encoding: string, bom: boolean) => void;
  onEolOverride: () => void;
}) {
  const [position, setPosition] = useState<{ line: number; column: number } | null>(null);
  const [indent, setIndent] = useState<{ insertSpaces: boolean; size: number } | null>(null);
  const [eol, setEol] = useState<'LF' | 'CRLF' | null>(null);
  const [openMenu, setOpenMenu] = useState<MenuKind | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Monaco の状態を購読して表示へミラーする。activePath はモデル切替の再読取り用。
  useEffect(() => {
    if (!editor) return;
    const read = () => {
      const pos = editor.getPosition();
      setPosition(pos ? { line: pos.lineNumber, column: pos.column } : null);
      const model = editor.getModel();
      if (model) {
        const o = model.getOptions();
        setIndent({ insertSpaces: o.insertSpaces, size: o.insertSpaces ? o.indentSize : o.tabSize });
        setEol(model.getEOL() === '\r\n' ? 'CRLF' : 'LF');
      } else {
        setIndent(null);
        setEol(null);
      }
    };
    read();
    const subs = [
      editor.onDidChangeCursorPosition(read),
      editor.onDidChangeModel(read),
      editor.onDidChangeModelOptions(read),
      editor.onDidChangeModelContent(read), // EOL 変更(pushEOL)もここで届く
    ];
    return () => subs.forEach((d) => d.dispose());
  }, [editor, activePath]);

  // メニュー外クリックと Escape で閉じる
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  const toggleMenu = (kind: MenuKind) => setOpenMenu((cur) => (cur === kind ? null : kind));

  const chooseIndent = (insertSpaces: boolean, size: number) => {
    // 内容は変更しない(dirty にならない)。既存インデントの変換はスコープ外。
    editor?.getModel()?.updateOptions({ insertSpaces, tabSize: size, indentSize: size });
    setOpenMenu(null);
  };

  const chooseEol = (kind: 'lf' | 'crlf') => {
    const model = editor?.getModel();
    setOpenMenu(null);
    if (!model) return;
    // 既に同じ EOL でも、ユーザーが明示選択した事実は記録する。理由: ファイルが既に
    // 望みの EOL・.editorconfig が別指定のケースでは pushEOL は不要だが、ここで記録
    // しないと保存時に formatOnSave が editorconfig 側へ戻してしまう。
    onEolOverride();
    const want = kind === 'crlf' ? '\r\n' : '\n';
    if (model.getEOL() === want) return;
    // pushEOL は undo に乗り、onDidChangeModelContent 経由で draft も dirty になる
    model.pushEOL(
      kind === 'crlf' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF,
    );
  };

  const currentEncoding = encodingLabel(file.encoding, file.hasBom);

  return (
    <div className="editor-statusbar" ref={rootRef}>
      {position && (
        <span className="statusbar-item static">
          行 {position.line}, 列 {position.column}
        </span>
      )}
      {indent && (
        <span className="statusbar-anchor">
          <button
            className="statusbar-item"
            title="インデントを変更"
            onClick={() => toggleMenu('indent')}
          >
            {indent.insertSpaces ? `スペース: ${indent.size}` : `タブ: ${indent.size}`}
          </button>
          {openMenu === 'indent' && (
            <div className="statusbar-menu">
              {INDENT_CHOICES.map((c) => (
                <MenuItem
                  key={c.label}
                  label={c.label}
                  selected={indent.insertSpaces === c.insertSpaces && indent.size === c.size}
                  onClick={() => chooseIndent(c.insertSpaces, c.size)}
                />
              ))}
            </div>
          )}
        </span>
      )}
      {currentEncoding && (
        <span className="statusbar-anchor">
          <button
            className="statusbar-item"
            title="エンコーディングを変更"
            onClick={() => toggleMenu('encoding')}
          >
            {currentEncoding}
          </button>
          {openMenu === 'encoding' && (
            <div className="statusbar-menu">
              <MenuItem
                label="エンコーディング指定で再読み込み..."
                onClick={() => setOpenMenu('encoding-reload')}
              />
              <MenuItem
                label="エンコーディング指定で保存..."
                onClick={() => setOpenMenu('encoding-save')}
              />
            </div>
          )}
          {openMenu === 'encoding-reload' && (
            <div className="statusbar-menu">
              {RELOAD_ITEMS.map((c) => (
                <MenuItem
                  key={c.encoding}
                  label={c.label}
                  selected={file.encoding === c.encoding}
                  onClick={() => {
                    setOpenMenu(null);
                    onReloadWithEncoding(c.encoding);
                  }}
                />
              ))}
            </div>
          )}
          {openMenu === 'encoding-save' && (
            <div className="statusbar-menu">
              {SAVE_ITEMS.map((c) => (
                <MenuItem
                  key={c.label}
                  label={c.label}
                  selected={file.encoding === c.encoding && file.hasBom === c.bom}
                  onClick={() => {
                    setOpenMenu(null);
                    onSaveWithEncoding(c.encoding, c.bom);
                  }}
                />
              ))}
            </div>
          )}
        </span>
      )}
      {eol && (
        <span className="statusbar-anchor">
          <button className="statusbar-item" title="改行コードを変更" onClick={() => toggleMenu('eol')}>
            {eol}
          </button>
          {openMenu === 'eol' && (
            <div className="statusbar-menu">
              <MenuItem label="LF" selected={eol === 'LF'} onClick={() => chooseEol('lf')} />
              <MenuItem label="CRLF" selected={eol === 'CRLF'} onClick={() => chooseEol('crlf')} />
            </div>
          )}
        </span>
      )}
    </div>
  );
}
