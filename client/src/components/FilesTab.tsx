import { useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { api } from '../api';
import type { FileContent } from '../types';
import FileTree from './FileTree';

export default function FilesTab({ root }: { root: string }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const saveRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!selectedPath) return;
    setFile(null);
    setMessage('');
    api
      .file(root, selectedPath)
      .then((f) => {
        setFile(f);
        setDraft(f.content ?? '');
      })
      .catch((e: Error) => setMessage(`⚠ ${e.message}`));
  }, [root, selectedPath]);

  const modified = file?.content !== null && draft !== file?.content;

  const save = async () => {
    if (!selectedPath || !file || file.content === draft) return;
    setSaving(true);
    try {
      await api.saveFile(root, selectedPath, draft);
      setFile({ ...file, content: draft });
      setMessage('✓ 保存しました');
      setTimeout(() => setMessage(''), 2500);
    } catch (e) {
      setMessage(`⚠ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = () => void save();

  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
  };

  return (
    <div className="files-tab">
      <div className="files-tree-pane">
        <FileTree root={root} selectedPath={selectedPath} onSelectFile={setSelectedPath} />
      </div>
      <div className="files-editor-pane">
        {!selectedPath ? (
          <div className="placeholder">ファイルを選択してください</div>
        ) : !file ? (
          <div className="placeholder">{message || '読み込み中...'}</div>
        ) : file.binary ? (
          <div className="placeholder">バイナリファイルは表示できません ({file.size} bytes)</div>
        ) : file.tooLarge ? (
          <div className="placeholder">ファイルが大きすぎます ({Math.round(file.size / 1024)} KB)</div>
        ) : (
          <>
            <div className="editor-toolbar">
              <span className="editor-path" title={selectedPath}>
                {selectedPath}
                {modified && <span className="editor-modified"> ●</span>}
              </span>
              <span className="editor-msg">{message}</span>
              <button
                className="primary"
                disabled={!modified || saving}
                onClick={() => void save()}
                title="Ctrl+S でも保存できます"
              >
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
            <div className="editor-host">
              <Editor
                path={selectedPath}
                value={draft}
                onChange={(value) => setDraft(value ?? '')}
                onMount={onMount}
                theme="vs-dark"
                options={{
                  fontSize: 13,
                  minimap: { enabled: true },
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  renderWhitespace: 'selection',
                }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
