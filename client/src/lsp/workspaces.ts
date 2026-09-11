/**
 * leafId → ワークスペース (root と、定義ジャンプの着地・通知の口)。FilesTab が registerFilesTab と
 * 同じ effect で登録する。transferRegistry.ts と同じ Map ベースのモジュール状態。
 *
 * documents.ts はモデル生成時に leafId から root を引く。<Editor> の effect (子) は FilesTab の
 * 登録 effect (親) より先に走るので、未登録の leafId のモデルは登録時に拾い直す — そのための subscribe。
 */
export interface LspWorkspace {
  root: string;
  openAtLine: (path: string, line: number, column: number) => void;
  /** ステータス行への短い通知 (ワークスペース外への定義ジャンプなど) */
  notify: (text: string) => void;
}

const byLeaf = new Map<string, LspWorkspace>();
const listeners = new Set<(leafId: string) => void>();

export function registerLspWorkspace(leafId: string, ws: LspWorkspace): void {
  byLeaf.set(leafId, ws);
  for (const l of listeners) l(leafId);
}

export function unregisterLspWorkspace(leafId: string): void {
  byLeaf.delete(leafId);
}

export function getLspWorkspace(leafId: string): LspWorkspace | undefined {
  return byLeaf.get(leafId);
}

export function onLspWorkspaceRegistered(listener: (leafId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
