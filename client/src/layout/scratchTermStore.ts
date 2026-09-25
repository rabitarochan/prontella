import { create } from 'zustand';
import { api } from '../api';

/**
 * 一時ターミナル (どの workspace にも属さない、ホームディレクトリーで開く PTY) の
 * モーダル開閉と、その cwd になるホームディレクトリーの保持。
 *
 * モード (vncViewStore / monitorViewStore) ではなく**モーダル**なので、
 * mainMode の「選択を外して他方を抜ける」作法は要らない — worktree の選択とは
 * 排他でなく、開いている間も背後の画面はそのまま生きている。
 *
 * 永続化しない: リロードで閉じてよい (モーダルの普通の振る舞い)。
 *
 * `visited` は一度開いたら下ろさないためのフラグ。xterm は再マウントで
 * WebSocket が張り直されスクロールバックが消えるため、閉じるときは
 * アンマウントせず display:none にする (pj-client-ui-state §14)。
 */

let homeDirInflight: Promise<void> | null = null;

interface ScratchTermState {
  open: boolean;
  visited: boolean;
  homeDir: string | null;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** ホームディレクトリーを 1 回だけ取る (多重呼び出しは同じ Promise に相乗り)。 */
  loadHomeDir: () => Promise<void>;
}

export const useScratchTerm = create<ScratchTermState>((set, get) => ({
  open: false,
  visited: false,
  homeDir: null,
  setOpen: (open) => {
    if (open) void get().loadHomeDir();
    set(open ? { open: true, visited: true } : { open: false });
  },
  toggle: () => get().setOpen(!get().open),
  loadHomeDir: () => {
    if (get().homeDir !== null) return Promise.resolve();
    if (homeDirInflight) return homeDirInflight;
    homeDirInflight = api
      .settings()
      .then((s) => {
        set({ homeDir: s.homeDir });
      })
      .catch(() => {
        // サーバー再起動中など。次に開いたときに取り直す。
      })
      .finally(() => {
        homeDirInflight = null;
      });
    return homeDirInflight;
  },
}));
