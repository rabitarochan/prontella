// ターミナルグループツリー + アクティブグループの状態ホルダー。
// components/files/useEditorGroups.ts と同じ役割・同じ規律:
// 木の変換は termGroups.ts の純関数で行い、この hook は
// 「root と activeGroupId を常に整合した 1 つの状態として持つ」ことと
// 「set と同期で ref を更新し、連続操作が stale な木を読まない」ことだけを担う。

import { useCallback, useRef, useState } from 'react';
import {
  allTermGroups,
  findTermGroup,
  makeTermGroup,
  type TermGroupNode,
} from './termGroups';
import type { LeafTermState } from './termState';

export interface TermGroupsState {
  root: TermGroupNode;
  /** 常に root 内に存在するグループ id (set が保証する) */
  activeGroupId: string;
}

function initState(initial: LeafTermState | null): TermGroupsState {
  if (initial) return { root: initial.groups, activeGroupId: initial.activeGroupId };
  const g = makeTermGroup();
  return { root: g, activeGroupId: g.id };
}

export function useTermGroups(initial: LeafTermState | null) {
  const [state, setState] = useState<TermGroupsState>(() => initState(initial));
  const stateRef = useRef(state);

  /** 木を差し替える。activate 指定 (存在すれば) > 現アクティブ (生存していれば) >
   *  先頭グループ、の順で activeGroupId の整合を取る。 */
  const set = useCallback((root: TermGroupNode, opts?: { activate?: string }) => {
    const prev = stateRef.current;
    const activeGroupId =
      (opts?.activate && findTermGroup(root, opts.activate) ? opts.activate : null) ??
      (findTermGroup(root, prev.activeGroupId) ? prev.activeGroupId : allTermGroups(root)[0].id);
    if (prev.root === root && prev.activeGroupId === activeGroupId) return;
    const next: TermGroupsState = { root, activeGroupId };
    stateRef.current = next;
    setState(next);
  }, []);

  const setActiveGroup = useCallback((groupId: string) => {
    const prev = stateRef.current;
    if (prev.activeGroupId === groupId || !findTermGroup(prev.root, groupId)) return;
    const next: TermGroupsState = { root: prev.root, activeGroupId: groupId };
    stateRef.current = next;
    setState(next);
  }, []);

  /** Worktree 切替 (root change) 用の全リセット。 */
  const reset = useCallback((nextInitial: LeafTermState | null) => {
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

export type TermGroupsApi = ReturnType<typeof useTermGroups>;
