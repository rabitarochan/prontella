import { useMemo, useState } from "react";
import type { BranchInfo } from "../types";

interface FolderNode {
  kind: "folder";
  name: string;
  path: string; // フォルダのフルパス (折りたたみ状態のキーにも使う)
  children: TreeNode[];
}

interface LeafNode {
  kind: "leaf";
  name: string; // 末尾セグメントのみ (表示用)
  branch: BranchInfo; // branch.name がフルネーム
}

type TreeNode = FolderNode | LeafNode;

/** ブランチ名を `/` で分割し、フォルダ→葉のツリーに組み立てる。 */
function buildTree(branches: BranchInfo[]): TreeNode[] {
  const root: FolderNode = { kind: "folder", name: "", path: "", children: [] };
  for (const b of branches) {
    const segs = b.name.split("/");
    let cur = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      const path = cur.path ? `${cur.path}/${seg}` : seg;
      let next = cur.children.find(
        (c): c is FolderNode => c.kind === "folder" && c.name === seg,
      );
      if (!next) {
        next = { kind: "folder", name: seg, path, children: [] };
        cur.children.push(next);
      }
      cur = next;
    }
    cur.children.push({ kind: "leaf", name: segs[segs.length - 1], branch: b });
  }
  sortTree(root);
  return root.children;
}

/** 同階層は フォルダ→葉、各グループ内は名前昇順。 */
function sortTree(node: FolderNode) {
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const c of node.children) if (c.kind === "folder") sortTree(c);
}

const BASE_INDENT = 16; // .git-branch-row / 既存の折り畳みヘッダーと揃える
const DEPTH_INDENT = 19;

export default function BranchTree({
  branches,
  currentBranch = null,
  worktreePath,
  onContextMenu,
}: {
  branches: BranchInfo[];
  currentBranch?: string | null;
  worktreePath?: string;
  onContextMenu?: (e: React.MouseEvent, branch: BranchInfo) => void;
}) {
  // 開いているフォルダのフルパスを保持。初期値は空 = 全フォルダ閉じ。
  // GitTab の 10 秒ポーリングで branches が更新されても、この state はここに
  // 留まる (BranchTree 自体は key で再マウントされない) ので開閉はリセットされない。
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const tree = useMemo(() => buildTree(branches), [branches]);

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const paddingLeft = BASE_INDENT + depth * DEPTH_INDENT;

    if (node.kind === "folder") {
      const isOpen = expanded.has(node.path);
      return (
        <div key={`d:${node.path}`}>
          <div
            className="git-branch-folder-row"
            style={{ paddingLeft }}
            onClick={() => toggle(node.path)}
          >
            <span
              className={`codicon codicon-chevron-${isOpen ? "down" : "right"} branch-twisty`}
            />
            <span className="branch-folder-name">{node.name}</span>
          </div>
          {isOpen && node.children.map((c) => renderNode(c, depth + 1))}
        </div>
      );
    }

    const b = node.branch;
    const isCurrent = b.name === currentBranch;
    const usedElsewhere =
      !!b.worktreePath &&
      !!worktreePath &&
      b.worktreePath !== worktreePath.replace(/\\/g, "/");

    return (
      <div
        key={`f:${b.name}`}
        className={`git-branch-row ${isCurrent ? "current" : ""}`}
        style={{ paddingLeft }}
        title={b.name}
        onContextMenu={
          onContextMenu && !isCurrent
            ? (e) => {
                e.preventDefault();
                onContextMenu(e, b);
              }
            : undefined
        }
      >
        {/* フォルダの chevron と同じ幅を空けて、名前の開始位置を縦に揃える */}
        <span className="branch-twisty" />
        <span className="branch-name">
          {node.name}
          {usedElsewhere && (
            <span className="branch-used-mark" title="他の Worktree で使用中">
              {" "}
              ◈
            </span>
          )}
        </span>
        {isCurrent && <span className="branch-current-mark">✓</span>}
      </div>
    );
  };

  return <>{tree.map((n) => renderNode(n, 0))}</>;
}
