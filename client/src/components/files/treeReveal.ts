/**
 * ファイルツリーの自動リビール用の純関数。
 *
 * ノード id は「ルートからの相対 posix パス」(FileTree.tsx の TNode.id)。ルート自身は
 * '' で表現されるが、react-arborist のノードとしては存在しないので祖先には含めない。
 */

/**
 * 'a/b/c.ts' → ['a', 'a/b'] を返す。展開はルート側から順に行う必要があるため、
 * 必ず浅い順 (親が先) で返す。ルート直下のファイルは [] になる。
 */
export function ancestorDirs(path: string): string[] {
  // 前後のスラッシュと空セグメントを落とす ('/a//b.ts' も 'a/b.ts' と同じ扱いにする)
  const parts = path.split('/').filter((s) => s !== '');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}
