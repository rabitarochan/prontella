import { useEffect, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { Check } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useT } from '../i18n';
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

// label はモジュールスコープに直接持たせず、insertSpaces/size のみ保持して
// 描画時に t() で組み立てる (StatusBadge の LABELS パターン)。
const INDENT_CHOICES: { insertSpaces: boolean; size: number }[] = [
  { insertSpaces: true, size: 2 },
  { insertSpaces: true, size: 4 },
  { insertSpaces: true, size: 8 },
  { insertSpaces: false, size: 2 },
  { insertSpaces: false, size: 4 },
  { insertSpaces: false, size: 8 },
];

function encodingLabel(encoding: string | null, hasBom: boolean): string | null {
  if (!encoding) return null;
  const base = ENCODING_LABELS[encoding] ?? encoding;
  return encoding === 'utf-8' && hasBom ? `${base} with BOM` : base;
}

// legacy .statusbar-item は base 層の data-slot ミニリセットに負けるため、
// トリガーは Tailwind ユーティリティで直接スタイルする
const TRIGGER_CLS =
  'cursor-pointer rounded-sm px-2 py-0.5 hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground';

function CheckItem({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <Check className={cn('size-4', !selected && 'invisible')} />
      {label}
    </DropdownMenuItem>
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
  const t = useT();
  const [position, setPosition] = useState<{ line: number; column: number } | null>(null);
  const [indent, setIndent] = useState<{ insertSpaces: boolean; size: number } | null>(null);
  const [eol, setEol] = useState<'LF' | 'CRLF' | null>(null);

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

  const chooseIndent = (insertSpaces: boolean, size: number) => {
    // 内容は変更しない(dirty にならない)。既存インデントの変換はスコープ外。
    editor?.getModel()?.updateOptions({ insertSpaces, tabSize: size, indentSize: size });
  };

  const chooseEol = (kind: 'lf' | 'crlf') => {
    const model = editor?.getModel();
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
  const indentLabel = (c: { insertSpaces: boolean; size: number }) =>
    c.insertSpaces ? t('files.indentSpaces', { n: c.size }) : t('files.indentTabs', { n: c.size });

  return (
    <div className="editor-statusbar">
      {position && (
        <span className="statusbar-item static">
          {t('files.positionIndicator', { line: position.line, column: position.column })}
        </span>
      )}
      {indent && (
        <DropdownMenu>
          <DropdownMenuTrigger className={TRIGGER_CLS} title={t('files.changeIndentTooltip')}>
            {indentLabel(indent)}
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
            {INDENT_CHOICES.map((c) => (
              <CheckItem
                key={`${c.insertSpaces}-${c.size}`}
                label={indentLabel(c)}
                selected={indent.insertSpaces === c.insertSpaces && indent.size === c.size}
                onSelect={() => chooseIndent(c.insertSpaces, c.size)}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {currentEncoding && (
        <DropdownMenu>
          <DropdownMenuTrigger className={TRIGGER_CLS} title={t('files.changeEncodingTooltip')}>
            {currentEncoding}
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{t('files.reloadWithEncoding')}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {RELOAD_ITEMS.map((c) => (
                  <CheckItem
                    key={c.encoding}
                    label={c.label}
                    selected={file.encoding === c.encoding}
                    onSelect={() => onReloadWithEncoding(c.encoding)}
                  />
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{t('files.saveWithEncoding')}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {SAVE_ITEMS.map((c) => (
                  <CheckItem
                    key={c.label}
                    label={c.label}
                    selected={file.encoding === c.encoding && file.hasBom === c.bom}
                    onSelect={() => onSaveWithEncoding(c.encoding, c.bom)}
                  />
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {eol && (
        <DropdownMenu>
          <DropdownMenuTrigger className={TRIGGER_CLS} title={t('files.changeEolTooltip')}>
            {eol}
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
            <CheckItem label="LF" selected={eol === 'LF'} onSelect={() => chooseEol('lf')} />
            <CheckItem label="CRLF" selected={eol === 'CRLF'} onSelect={() => chooseEol('crlf')} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
