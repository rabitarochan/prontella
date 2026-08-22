// ディスク上のファイルが「開いたときから変わったか」を判定し、どう扱うかを決める純関数。
//
// コンポーネント (.tsx) は vitest の include 対象外で回帰テストできない (pj-client-ui-state §0)
// ため、判定はここ (.ts) に切り出して真理値表を diskSync.test.ts で固定する。
//
// 判定器は mtime / size ではなく「内容そのものの一致」を使う。サーバーは元々
// 全読み込み + エンコーディング判定をしており (server/files.ts の readFileContent)、
// 内容比較は判定器ではなく真理値そのものなので、mtime 粒度・同サイズ書き換え・
// mtime を保存するツール、といった分岐の検証が要らない。

import { hashText } from '../../editorState';
import type { TabKind } from '../../editorState';
import type { FileContent } from '../../types';

/** FileEntry (useFileEntries.ts) の構造的サブセット。循環 import を避けるため独自定義。 */
export interface DiskSyncEntry {
  kind: TabKind;
  file: FileContent | null;
  draft: string;
}

export type SyncDecision =
  /** 判定対象外 — fetch もしない (preview / 未ロード / 元から binary・tooLarge) */
  | { kind: 'skip' }
  /** ディスクは開いたときのまま — draft には触れない */
  | { kind: 'unchanged' }
  /** 最新化する (未編集、または編集内容がディスクと一致) */
  | { kind: 'apply' }
  /** 編集中に外部変更された — バナーで選ばせる */
  | { kind: 'conflict' }
  /** 同じディスク内容を既に「編集を継続」で見送り済み — 二度は聞かない */
  | { kind: 'suppressed' };

/**
 * 「見送り済み」の記録に使うディスク内容の指紋。
 * content が null (binary / tooLarge) のときは比較できる文字列が無いので、サイズと種別で
 * 代用する。取りこぼしても「もう一度聞かれる」だけで、編集内容を失う側には倒れない。
 */
export function diskHash(f: FileContent): string {
  if (f.content === null) return `nil:${f.size}:${f.binary ? 'b' : 't'}`;
  return hashText(f.content);
}

/**
 * fetch する価値があるか。false ならリクエスト自体を出さない。
 * decideDiskSync の判定 1〜3 と同じ条件 (両者は必ず一致させる)。
 */
export function shouldCheckDisk(entry: DiskSyncEntry | null | undefined): boolean {
  if (!entry) return false;
  if (entry.kind !== 'editor') return false; // preview は refreshPreviewTab の担当
  if (entry.file === null) return false; // 初回ロード中
  if (entry.file.content === null) return false; // 元から binary / tooLarge
  return true;
}

/**
 * 取得したディスク内容をどう扱うか。
 * `ignoredHash` は「編集を継続」で見送った時点の diskHash (path 単位で記憶する)。
 */
export function decideDiskSync(
  entry: DiskSyncEntry,
  disk: FileContent,
  ignoredHash?: string,
): SyncDecision {
  const file = entry.file;
  // shouldCheckDisk と同じ条件。null 絞り込みを兼ねるのでここでも書く。
  if (entry.kind !== 'editor' || file === null || file.content === null) return { kind: 'skip' };

  if (disk.content === file.content) return { kind: 'unchanged' };

  // 未編集 → 黙って最新化する (このプロダクトの主用途)
  if (entry.draft === file.content) return { kind: 'apply' };
  // 編集内容がたまたまディスクと一致 → 適用すれば dirty が解消するので聞く必要がない
  if (disk.content !== null && entry.draft === disk.content) return { kind: 'apply' };

  if (ignoredHash !== undefined && ignoredHash === diskHash(disk)) return { kind: 'suppressed' };
  return { kind: 'conflict' };
}
