// エディターグループツリー + アクティブグループの状態ホルダー。
// 木の変換は editorGroups.ts の純関数で行い、この hook は
// 「root と activeGroupId を常に整合した 1 つの状態として持つ」ことと
// 「set と同期で ref を更新し、連続操作が stale な木を読まない」ことだけを担う
// (useTileLayout.ts の layoutRef と同じ動機。ただしこちらは set 内で同期更新する —
// 1 つのユーザー操作で「木を読む → 変換 → set → orphan 算出 → 破棄」まで走るため)。

import { useCallback, useRef, useState } from 'react';
import type { LeafEditorState } from '../../editorState';
import { allGroups, findGroup, makeGroup, type GroupNode } from './editorGroups';

interface GroupsState {
  root: GroupNode;
  /** 常に root 内に存在するグループ id (set が保証する) */
  activeGroupId: string;
}

function initState(initial: LeafEditorState | null): GroupsState {
  if (initial) return { root: initial.groups, activeGroupId: initial.activeGroupId };
  const g = makeGroup();
  return { root: g, activeGroupId: g.id };
}

export function useEditorGroups(initial: LeafEditorState | null) {
  const [state, setState] = useState<GroupsState>(() => initState(initial));
  const stateRef = useRef(state);

  /** 木を差し替える。activate 指定 (存在すれば) > 現アクティブ (生存していれば) >
   *  先頭グループ、の順で activeGroupId の整合を取る。 */
  const set = useCallback((root: GroupNode, opts?: { activate?: string }) => {
    const prev = stateRef.current;
    const activeGroupId =
      (opts?.activate && findGroup(root, opts.activate) ? opts.activate : null) ??
      (findGroup(root, prev.activeGroupId) ? prev.activeGroupId : allGroups(root)[0].id);
    const next: GroupsState = { root, activeGroupId };
    stateRef.current = next;
    setState(next);
  }, []);

  const setActiveGroup = useCallback(
    (groupId: string) => {
      const prev = stateRef.current;
      if (prev.activeGroupId === groupId || !findGroup(prev.root, groupId)) return;
      const next: GroupsState = { root: prev.root, activeGroupId: groupId };
      stateRef.current = next;
      setState(next);
    },
    [],
  );

  /** Worktree 切替 (root change) 用の全リセット。 */
  const reset = useCallback((nextInitial: LeafEditorState | null) => {
    const next = initState(nextInitial);
    stateRef.current = next;
    setState(next);
  }, []);

  return {
    root: state.root,
    activeGroupId: state.activeGroupId,
    stateRef,
    set,
    setActiveGroup,
    reset,
  };
}

export type EditorGroupsApi = ReturnType<typeof useEditorGroups>;
