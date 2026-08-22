// クロス leaf のタブ転送 (別タイルのファイルパネルへの DnD 移動)。
// search/registry.ts と同型のモジュール Map — マウント中の FilesTab が leafId で
// ハンドルを登録し、ドロップを受けた側 (target) が source のハンドルを引いて駆動する:
//   ① source.exportTab (読み取りのみ) → ② sanitizeTransferPayload → ③ target が
//   pending draft を積んでから openTab (既存 loadFile の baseHash 照合を再利用) →
//   ④ 成立時のみ source.removeTabAfterTransfer。途中失敗なら source は無傷。
// 重複ルール: 転送先 leaf に同じ {kind, path} が既に開いていたら転送中止 +
// 既存タブをアクティブ化 (draft のマージは絶対にしない)。

import { MAX_DRAFT_TEXT_LENGTH, type TabKind } from '../../editorState';

export interface TabTransferPayload {
  kind: TabKind;
  path: string;
  /** dirty な editor タブのみ。baseHash は draft の元になった disk 内容のハッシュ。 */
  draft?: { text: string; baseHash: string };
}

export interface FilesTabTransferHandle {
  /**
   * タブの転送データを読み取る (source 側は変更しない)。
   * null = 転送不可 (タブ不在、または draft が大きすぎて運ぶと失われる場合 —
   * 未保存編集のサイレント破壊は絶対にしない)。
   */
  exportTab: (key: string) => TabTransferPayload | null;
  /** 転送成立後の source 側タブ除去。確認なし (内容は引っ越し済みなので破壊ではない)。 */
  removeTabAfterTransfer: (groupId: string, key: string) => void;
}

/**
 * 受け取った payload の防御的検証 (純関数)。転送元は同一アプリの別 leaf だが、
 * editorState.ts の復元経路と同じ規則で二重に守る: パスは空/".." セグメントを拒否、
 * draft は形と上限を検証し、超過は payload ごと拒否 (削って運ぶと編集が失われる)。
 */
export function sanitizeTransferPayload(raw: TabTransferPayload): TabTransferPayload | null {
  if (raw.kind !== 'editor' && raw.kind !== 'preview') return null;
  if (typeof raw.path !== 'string' || raw.path === '' || raw.path.split('/').includes('..')) {
    return null;
  }
  if (raw.draft === undefined) return { kind: raw.kind, path: raw.path };
  if (raw.kind !== 'editor') return null; // preview は draft を持てない
  if (typeof raw.draft.text !== 'string' || typeof raw.draft.baseHash !== 'string') return null;
  if (raw.draft.text.length > MAX_DRAFT_TEXT_LENGTH) return null;
  return { kind: raw.kind, path: raw.path, draft: { text: raw.draft.text, baseHash: raw.draft.baseHash } };
}

const handles = new Map<string, FilesTabTransferHandle>();

export function registerTransferHandle(leafId: string, handle: FilesTabTransferHandle): void {
  handles.set(leafId, handle);
}

export function unregisterTransferHandle(leafId: string): void {
  handles.delete(leafId);
}

export function getTransferHandle(leafId: string): FilesTabTransferHandle | null {
  return handles.get(leafId) ?? null;
}
