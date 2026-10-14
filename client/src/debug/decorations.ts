import * as monaco from 'monaco-editor';
import { parseModelUri } from '../lsp/uri';
import { getLspWorkspace, onLspWorkspaceRegistered } from '../lsp/workspaces';
import { buildDecorations } from './glyphs';
import { useDebugStore } from './store';

/**
 * ブレークポイントのグリフと現在行の装飾。documents.ts / useGitGutter と同じく React ではなく
 * `monaco.editor.onDidCreateModel` に乗り、**model に張る** (editor に張るとグループ分割で重なる。gitDecorations.ts)。
 * root は model URI の leafId → getLspWorkspace(leafId).root で引く (FilesTab が登録する)。
 * 装飾の中身は glyphs.ts (純関数、vitest 対象)。
 */

const applied = new WeakMap<monaco.editor.ITextModel, string[]>();
let started = false;

function locate(model: monaco.editor.ITextModel): { root: string; path: string } | null {
  const ref = parseModelUri(model.uri.toString());
  if (!ref) return null;
  const ws = getLspWorkspace(ref.leafId);
  return ws ? { root: ws.root, path: ref.path } : null;
}

function refresh(model: monaco.editor.ITextModel): void {
  if (model.isDisposed()) return;
  const loc = locate(model);
  const st = useDebugStore.getState();
  const lines = loc ? (st.ensureBreakpoints(loc.root)[loc.path] ?? []) : [];
  const run = loc ? st.runs[loc.root] : undefined;
  const cur = loc && run?.currentLine && run.currentLine.path === loc.path ? run.currentLine.line : null;
  const running = run?.phase === 'starting' || run?.phase === 'running' || run?.phase === 'stopped';
  const next = buildDecorations(lines, loc ? run?.verified[loc.path] : undefined, cur, model.getLineCount(), running);
  const prev = applied.get(model) ?? [];
  if (prev.length === 0 && next.length === 0) return;
  applied.set(model, model.deltaDecorations(prev, next));
}

function refreshAll(): void {
  for (const m of monaco.editor.getModels()) refresh(m);
}

/** 起動時に 1 回。モデルの生死と store の変化で装飾を張り直す。 */
export function startDebugDecorations(): void {
  if (started) return;
  started = true;
  monaco.editor.onDidCreateModel((m) => {
    refresh(m);
    // 行の増減で BP 行がずれるのは追わない (要求行は固定)。行数が減って範囲外になった分だけ消す
    m.onDidChangeContent(() => refresh(m));
  });
  monaco.editor.onWillDisposeModel((m) => applied.delete(m));
  onLspWorkspaceRegistered(refreshAll);
  useDebugStore.subscribe(refreshAll);
  refreshAll();
}

/** ガタークリック (EditorGroupPane の onMouseDown) から。root が引けないモデルでは何もしない。 */
export function toggleBreakpointAt(model: monaco.editor.ITextModel, line: number): boolean {
  const loc = locate(model);
  if (!loc) return false;
  useDebugStore.getState().toggleBreakpoint(loc.root, loc.path, line);
  return true;
}
