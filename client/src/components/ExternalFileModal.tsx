import { useEffect, useState } from 'react';
import * as monaco from 'monaco-editor';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useT } from '../i18n';
import { useTheme } from '../theme/themeStore';
import { monacoThemeName } from '../theme/monacoTheme';

/**
 * root 外 / 上限超えファイルの読み取り専用ビューアー (client/src/lsp/external.ts のモデルを表示する)。
 * BlameModal / FileHistoryModal と同じ作法のモーダル。モデルは external.ts の LRU が持つので
 * ここでは dispose しない (エディターだけ捨てる)。
 */
export default function ExternalFileModal({
  model,
  line,
  column,
  onClose,
}: {
  model: monaco.editor.ITextModel;
  line: number;
  column: number;
  onClose: () => void;
}) {
  const t = useT();
  // Radix の Portal は最初のコミットでは中身を描画しない (mounted state を layout effect で立ててから描く) ので、
  // useRef だと効果の実行時に要素が無く、deps が変わらないため二度と作られない。コールバック ref で要素を state に持つ
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const resolvedTheme = useTheme((s) => s.resolved);
  const name = model.uri.path.split('/').pop() ?? model.uri.path;

  useEffect(() => {
    if (!host || model.isDisposed()) return;
    const editor = monaco.editor.create(host, {
      model,
      readOnly: true,
      theme: monacoThemeName(resolvedTheme),
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column });
    editor.focus();
    return () => editor.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, model, line, column]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[640px] max-h-[88vh] w-[92vw] flex-col sm:max-w-[1000px]">
        <DialogHeader>
          <DialogTitle className="truncate pr-6" title={name}>
            {t('files.lsp.externalTitle', { name })}
          </DialogTitle>
        </DialogHeader>
        <div ref={setHost} className="min-h-0 flex-1 overflow-hidden rounded-sm border" />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
