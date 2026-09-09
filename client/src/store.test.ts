import { beforeEach, describe, expect, it, vi } from 'vitest';

// api はネットワークに出るのでモックする。store.ts はこれ以外に外部依存を持たない
// (localStorage へのアクセスは全て try/catch されており、Node 上でも例外にならない)。
const reposMock = vi.fn();
vi.mock('./api', () => ({ api: { repos: () => reposMock() } }));

const { useDeck } = await import('./store');

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const repo = (name: string) => ({
  id: name, path: 'C:/x/' + name, name, pinned: false, archived: false,
  gitMode: 'root' as const, worktrees: [], error: null,
});

beforeEach(() => {
  reposMock.mockReset();
  useDeck.setState({ repos: [], loaded: false, selected: null, error: null });
});

describe('useDeck.refresh の in-flight 相乗り', () => {
  it('reuseInFlight を渡した呼び出しは進行中の取得に相乗りする', async () => {
    const d = deferred<unknown[]>();
    reposMock.mockReturnValue(d.promise);
    const { refresh } = useDeck.getState();

    const a = refresh({ reuseInFlight: true });
    const b = refresh({ reuseInFlight: true });
    d.resolve([repo('r1')]);
    await Promise.all([a, b]);

    expect(reposMock).toHaveBeenCalledTimes(1);
  });

  it('完了後は in-flight が解放され、次の呼び出しが新しく取得する', async () => {
    // 回帰テスト: finally() は新しい Promise を返すため、格納した Promise と
    // 比較しないと in-flight が永久に解放されず、以後のポーリングが全部
    // 相乗りして止まる (実ブラウザーで 45 秒に 1 回しか飛ばない状態になった)。
    reposMock.mockResolvedValue([repo('r1')]);
    const { refresh } = useDeck.getState();

    await refresh({ reuseInFlight: true });
    await refresh({ reuseInFlight: true });
    await refresh({ reuseInFlight: true });

    expect(reposMock).toHaveBeenCalledTimes(3);
  });

  it('取得が失敗しても in-flight は解放される', async () => {
    reposMock.mockRejectedValueOnce(new Error('通信失敗')).mockResolvedValue([repo('r1')]);
    const { refresh } = useDeck.getState();

    await refresh({ reuseInFlight: true });
    expect(useDeck.getState().error).toBe('通信失敗');
    await refresh({ reuseInFlight: true });

    expect(reposMock).toHaveBeenCalledTimes(2);
    expect(useDeck.getState().error).toBeNull();
  });

  it('reuseInFlight を渡さない呼び出し (変異直後) は進行中の取得に相乗りしない', async () => {
    const d = deferred<unknown[]>();
    reposMock.mockReturnValueOnce(d.promise).mockResolvedValue([repo('r2')]);
    const { refresh } = useDeck.getState();

    const poll = refresh({ reuseInFlight: true }); // 変異前に始まったポーリング
    const afterMutation = refresh();               // 変異直後の refresh
    d.resolve([repo('r1')]);
    await Promise.all([poll, afterMutation]);

    // 相乗りしていれば 1 回で済んでしまう。必ず自前で取り直すこと。
    expect(reposMock).toHaveBeenCalledTimes(2);
  });
});
