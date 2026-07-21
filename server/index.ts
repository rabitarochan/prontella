import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import * as config from './config.js';
import * as git from './git.js';
import * as files from './files.js';
import * as search from './search.js';
import { buildPartialPatch, splitDiffHunks } from './diffPatch.js';
import { PtyManager } from './pty.js';

const PORT = Number(process.env.PORT) || 3711;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 単発の未捕捉例外でサーバープロセス全体が落ちるのを防ぐ。ローカル開発ツールとして、
// ログだけ出してプロセスは生かし続け、個別リクエストが 500 を返すだけに留める。
process.on('uncaughtException', (err) => {
  console.error('[claude-deck3] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[claude-deck3] unhandledRejection:', reason);
});

const app = express();
app.use(express.json({ limit: '10mb' }));

const ptyManager = new PtyManager(PORT);

function asyncHandler(
  fn: (req: express.Request, res: express.Response) => Promise<void>,
): express.RequestHandler {
  return (req, res) => {
    fn(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    });
  };
}

function requireRepo(req: express.Request): config.RepoConfig {
  const repo = config.getRepo(req.params.id);
  if (!repo) throw new Error('リポジトリーが見つかりません');
  return repo;
}

// child が parent 自身または parent 配下かどうか(Windows の大文字小文字・ドライブレターは
// path.relative が吸収する)
function contains(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function queryStr(req: express.Request, name: string): string {
  const value = req.query[name];
  if (typeof value !== 'string' || !value) throw new Error(`クエリパラメーター ${name} が必要です`);
  return value;
}

// ---- repos -----------------------------------------------------------------

app.get('/api/repos', asyncHandler(async (_req, res) => {
  const { repos } = config.loadConfig();
  const result = await Promise.all(
    repos.map(async (repo) => {
      if (!fs.existsSync(repo.path)) {
        return { ...repo, gitMode: 'none', worktrees: [], error: `ディレクトリーが存在しません: ${repo.path}` };
      }
      const gitRoot = git.resolveGitRoot(repo.path);
      if (!gitRoot) {
        // none: git リポジトリーではない
        const pseudo = {
          path: repo.path, head: '', branch: null, isMain: true, locked: false,
          status: null, agent: ptyManager.statusFor(repo.path),
        };
        return { ...repo, gitMode: 'none', worktrees: [pseudo], error: null };
      }
      if (gitRoot !== repo.path) {
        // subdir: git リポジトリー下位のディレクトリー。Git タブは repo 全体スコープ
        try {
          const all = await git.listWorktrees(repo.path); // cwd=subdir でも repo 全体を返す
          const container = all
            .filter((wt) => contains(wt.path, repo.path))
            .sort((a, b) => b.path.length - a.path.length)[0]; // ネスト worktree は最深を採用
          let status: git.BranchStatus | null = null;
          try {
            status = await git.getBranchStatus(repo.path);
          } catch {
            // 破損時
          }
          const entry = {
            path: repo.path, head: container?.head ?? '', branch: container?.branch ?? null,
            isMain: true /* 削除✕を出さない */, locked: container?.locked ?? false,
            status, agent: ptyManager.statusFor(repo.path),
          };
          return { ...repo, gitMode: 'subdir', worktrees: [entry], error: null };
        } catch (e) {
          return { ...repo, gitMode: 'subdir', worktrees: [], error: e instanceof Error ? e.message : String(e) };
        }
      }
      try {
        const worktrees = await git.listWorktrees(repo.path);
        const detailed = await Promise.all(
          worktrees.map(async (wt) => {
            let status: git.BranchStatus | null = null;
            try {
              status = await git.getBranchStatus(wt.path);
            } catch {
              // worktree directory may be missing/prunable
            }
            return { ...wt, status, agent: ptyManager.statusFor(wt.path) };
          }),
        );
        return { ...repo, gitMode: 'root', worktrees: detailed, error: null };
      } catch (e) {
        return { ...repo, gitMode: 'root', worktrees: [], error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  res.json(result);
}));

app.post('/api/repos', asyncHandler(async (req, res) => {
  const repoPath = String(req.body.path ?? '');
  if (!repoPath) throw new Error('path が必要です');
  res.json(config.addRepo(repoPath));
}));

app.delete('/api/repos/:id', asyncHandler(async (req, res) => {
  config.removeRepo(req.params.id);
  res.json({ ok: true });
}));

app.get('/api/repos/:id/branches', asyncHandler(async (req, res) => {
  const repo = requireRepo(req);
  res.json(await git.listBranches(repo.path));
}));

// ---- worktrees -------------------------------------------------------------

app.post('/api/repos/:id/worktrees', asyncHandler(async (req, res) => {
  const repo = requireRepo(req);
  const { branch, newBranch, base } = req.body as {
    branch?: string;
    newBranch?: string;
    base?: string;
  };
  let worktreePath = String(req.body.path ?? '');
  if (!worktreePath) {
    const branchName = (newBranch || branch || 'detached').replace(/[\\/:*?"<>|]/g, '-');
    worktreePath = path.join(path.dirname(repo.path), `${repo.name}.worktrees`, branchName);
  }
  await git.addWorktree(repo.path, worktreePath, { branch, newBranch, base });
  res.json({ ok: true, path: worktreePath });
}));

app.delete('/api/repos/:id/worktrees', asyncHandler(async (req, res) => {
  const repo = requireRepo(req);
  const worktreePath = queryStr(req, 'path');
  await git.removeWorktree(repo.path, worktreePath, req.query.force === '1');
  res.json({ ok: true });
}));

// ---- git inspection (dir = any worktree path) -------------------------------

function requireKnownDir(req: express.Request): string {
  const dir = queryStr(req, 'dir');
  if (!fs.existsSync(dir)) throw new Error(`ディレクトリーが存在しません: ${dir}`);
  // git status/log 等は worktree root 相対で解釈されるため、subdir 登録時は git root に正規化する
  // (root 登録なら恒等変換)
  return git.resolveGitRoot(dir) ?? dir;
}

app.get('/api/git/log', asyncHandler(async (req, res) => {
  const dir = requireKnownDir(req);
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json(
    await git.getLog(dir, limit, {
      ref: typeof req.query.ref === 'string' ? req.query.ref : undefined,
      all: req.query.all === '1',
    }),
  );
}));

app.get('/api/git/commit', asyncHandler(async (req, res) => {
  const dir = requireKnownDir(req);
  const hash = queryStr(req, 'hash');
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw new Error('不正なコミットハッシュです');
  res.json({ text: await git.getCommitDetail(dir, hash) });
}));

app.get('/api/git/status', asyncHandler(async (req, res) => {
  const dir = requireKnownDir(req);
  res.json({
    branch: await git.getBranchStatus(dir),
    files: await git.getStatusFiles(dir),
    merging: await git.isMerging(dir), // 後方互換のため維持(新規実装は operation を見ること)
    operation: await git.getOperationState(dir),
  });
}));

// Original/modified content pair for Monaco DiffEditor.
//   scope=worktree: index vs working tree
//   scope=staged:   HEAD vs index
//   scope=commit:   parent vs commit (requires hash)
app.get('/api/git/diff-pair', asyncHandler(async (req, res) => {
  const dir = requireKnownDir(req);
  const filePath = queryStr(req, 'path');
  const scope = queryStr(req, 'scope');
  const origPath = typeof req.query.origPath === 'string' ? req.query.origPath : filePath;
  let original: string | null;
  let modified: string | null;
  if (scope === 'commit') {
    const hash = queryStr(req, 'hash');
    if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw new Error('不正なコミットハッシュです');
    original = await git.getFileAtRev(dir, `${hash}^`, origPath);
    modified = await git.getFileAtRev(dir, hash, filePath);
  } else if (scope === 'staged') {
    original = await git.getFileAtRev(dir, 'HEAD', origPath);
    modified = await git.getFileAtRev(dir, ':0', filePath);
  } else if (scope === 'worktree') {
    original = await git.getFileAtRev(dir, ':0', origPath);
    try {
      modified = fs.readFileSync(path.join(dir, filePath), 'utf8');
    } catch {
      modified = null; // deleted from the working tree
    }
  } else {
    throw new Error(`不正な scope です: ${scope}`);
  }
  const MAX = 2 * 1024 * 1024;
  const tooLarge = (original?.length ?? 0) > MAX || (modified?.length ?? 0) > MAX;
  const binary = !tooLarge && (original?.includes('\0') || modified?.includes('\0') || false);
  res.json({
    original: tooLarge || binary ? '' : (original ?? ''),
    modified: tooLarge || binary ? '' : (modified ?? ''),
    binary,
    tooLarge,
  });
}));

app.get('/api/git/commit-files', asyncHandler(async (req, res) => {
  const dir = requireKnownDir(req);
  const hash = queryStr(req, 'hash');
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw new Error('不正なコミットハッシュです');
  res.json(await git.getCommitFiles(dir, hash));
}));

app.get('/api/git/commit-message', asyncHandler(async (req, res) => {
  const dir = requireKnownDir(req);
  const hash = queryStr(req, 'hash');
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw new Error('不正なコミットハッシュです');
  res.json({ message: await git.getCommitMessage(dir, hash) });
}));

app.get('/api/git/diff', asyncHandler(async (req, res) => {
  const dir = requireKnownDir(req);
  res.json({
    text: await git.getDiff(dir, {
      path: typeof req.query.path === 'string' ? req.query.path : undefined,
      staged: req.query.staged === '1',
      untracked: req.query.untracked === '1',
    }),
  });
}));

// ハンク単位ステージ UI 用。scope=worktree: index vs working tree(git diff)、
// scope=staged: HEAD vs index(git diff --cached)。表示用なので utf8 文字列化でよい —
// ハンク境界の分割は '\n' と '@@ ' の位置だけで決まるため、apply-hunks 側の latin1 パースと
// hunkCount は一致する(POST /api/git/apply-hunks の expectedHunkCount にそのまま使える)。
app.get('/api/git/diff-hunks', asyncHandler(async (req, res) => {
  const dir = requireKnownDir(req);
  const filePath = queryStr(req, 'path');
  const scope = queryStr(req, 'scope');
  if (scope !== 'worktree' && scope !== 'staged') throw new Error(`不正な scope です: ${scope}`);
  const diffBuf = await git.getDiffBuffer(dir, filePath, scope === 'staged');
  const { header, hunks } = splitDiffHunks(diffBuf.toString('utf8'));
  res.json({ header, hunks, hunkCount: hunks.length });
}));

app.post('/api/git/stage', asyncHandler(async (req, res) => {
  await git.stageFile(bodyDir(req), String(req.body.path));
  res.json({ ok: true });
}));

app.post('/api/git/unstage', asyncHandler(async (req, res) => {
  await git.unstageFile(bodyDir(req), String(req.body.path));
  res.json({ ok: true });
}));

app.post('/api/git/commit', asyncHandler(async (req, res) => {
  const message = String(req.body.message ?? '').trim();
  if (!message) throw new Error('コミットメッセージが必要です');
  res.json({ result: await git.commit(bodyDir(req), message, req.body.amend === true) });
}));

function bodyDir(req: express.Request): string {
  const dir = String(req.body.dir ?? '');
  if (!dir || !fs.existsSync(dir)) throw new Error(`ディレクトリーが存在しません: ${dir}`);
  // requireKnownDir 同様、git root に正規化する
  return git.resolveGitRoot(dir) ?? dir;
}

// 登録ディレクトリー自身を git 化する意味論のため正規化しない(bodyDir は使わない)
app.post('/api/git/init', asyncHandler(async (req, res) => {
  const dir = String(req.body.dir ?? '');
  if (!dir || !fs.existsSync(dir)) throw new Error(`ディレクトリーが存在しません: ${dir}`);
  await git.init(dir);
  res.json({ ok: true });
}));

app.post('/api/git/stage-all', asyncHandler(async (req, res) => {
  await git.stageAll(bodyDir(req));
  res.json({ ok: true });
}));

app.post('/api/git/unstage-all', asyncHandler(async (req, res) => {
  await git.unstageAll(bodyDir(req));
  res.json({ ok: true });
}));

app.post('/api/git/discard', asyncHandler(async (req, res) => {
  const dir = bodyDir(req);
  const filePath = String(req.body.path ?? '');
  if (!filePath) throw new Error('path が必要です');
  if (req.body.untracked === true) {
    // recursive: 未追跡ディレクトリー(埋め込みリポジトリーなど git が `dir/` の
    // 1 エントリーとして報告するもの)もフォルダーごと削除する。
    fs.rmSync(files.safeResolve(dir, filePath), { recursive: true, force: true });
  } else {
    await git.discardFile(dir, filePath);
  }
  res.json({ ok: true });
}));

// ハンク単位ステージ/アンステージ/破棄。差分は毎回サーバー側で再生成して検証する
// (クライアントが古いハンク一覧をもとに送ってくる競合を expectedHunkCount + 選択ハンクの
// header 一致で検出するため。ハンク数が同じまま並行編集で中身が別位置にずれるケースは
// hunkCount だけでは検出できず、クリックしたのと別のハンクに操作が当たる恐れがある
// — discard は不可逆なのでこれはデータ喪失になりうる。実 git で再現確認済み)。
// asyncHandler は 500 固定のため、差分不一致(409)を返せるようこのルートだけ自前で包む。
app.post('/api/git/apply-hunks', (req, res) => {
  applyHunks(req, res).catch((err: unknown) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
});

async function applyHunks(req: express.Request, res: express.Response): Promise<void> {
  const dir = bodyDir(req);
  const filePath = String(req.body.path ?? '');
  if (!filePath) throw new Error('path が必要です');
  const scope = req.body.scope;
  if (scope !== 'stage' && scope !== 'unstage' && scope !== 'discard') {
    throw new Error(`不正な scope です: ${scope}`);
  }
  const selected = req.body.hunks;
  if (!Array.isArray(selected) || selected.length === 0 || !selected.every((n) => Number.isInteger(n))) {
    throw new Error('hunks は空でない number[] が必要です');
  }
  const expectedHunkCount = Number(req.body.expectedHunkCount);
  const expectedHeaders: unknown = req.body.expectedHeaders;
  // フェイルクローズド: selected と同順・同長の string[] でなければ検証不能なので即 409 とする
  // (expectedHunkCount が欠落 → NaN → 下の hunkCount 比較で 409 になるのと同じ精神)。
  if (
    !Array.isArray(expectedHeaders) ||
    expectedHeaders.length !== selected.length ||
    !expectedHeaders.every((h): h is string => typeof h === 'string')
  ) {
    res.status(409).json({ error: '差分が変化しました。再読み込みしてください' });
    return;
  }

  // stage/discard は worktree 差分(git diff)、unstage は staged 差分(git diff --cached)が
  // 権威データ。他画面での並行操作でハンク構成がずれていないか expectedHunkCount で確認する。
  const diffBuf = await git.getDiffBuffer(dir, filePath, scope === 'unstage');
  const { header, hunks } = splitDiffHunks(diffBuf.toString('latin1'));
  if (hunks.length === 0 || hunks.length !== expectedHunkCount) {
    res.status(409).json({ error: '差分が変化しました。再読み込みしてください' });
    return;
  }

  // hunkCount が同じでも、並行編集でハンクの中身が別位置に動いていることがある。選択した
  // 各インデックスについて、権威diffのハンク header がクライアントの期待(expectedHeaders)と
  // 一致するか確認する。
  //
  // ⚠ エンコーディングの罠: クライアントの header は GET /api/git/diff-hunks の utf8 デコード
  // (`diffBuf.toString('utf8')`)由来。一方このルートの `hunks`(適用に使う権威データ)は
  // latin1 パース(バイト保存。git apply へ渡すバイト列を一切変換しないため)。
  // `@@ -a,b +c,d @@ <関数名などのコンテキスト>` の後続に日本語が含まれると、utf8 と latin1 で
  // 同じバイト列でも文字列表現が異なり、latin1 側の header とそのまま比較すると変更が無くても
  // 偽 409 になってしまう。そこで比較専用に同じ Buffer を utf8 でも再パースし、utf8 側の
  // header を expectedHeaders と比較する(適用そのものは引き続き latin1 側の `hunks`/`header`
  // を使う)。
  //
  // インデックス対応(utf8 側 i 番目 = latin1 側 i 番目)が保たれる根拠: ハンク境界の分割は
  // `\n` と行頭 `@@ ` の出現位置だけで決まる(splitDiffHunks)。UTF-8 でも Shift_JIS 系
  // マルチバイト文字でも、後続バイトの値域は ASCII の `\n`(0x0A)や `@`,` `(0x40,0x20)と
  // 重ならないため、分割結果のハンク数は utf8/latin1 どちらでデコードしても一致する
  // (GET /api/git/diff-hunks 側のコメントにも記載済み)。ゆえに selected の同一インデックスで
  // 両者のハンクを対応づけられる。
  const { hunks: hunksUtf8 } = splitDiffHunks(diffBuf.toString('utf8'));
  for (let i = 0; i < selected.length; i++) {
    const authoritative = hunksUtf8[selected[i]];
    if (!authoritative || authoritative.header !== expectedHeaders[i]) {
      res.status(409).json({ error: '差分が変化しました。再読み込みしてください' });
      return;
    }
  }

  const patch = buildPartialPatch(header, hunks, selected);
  const patchBuf = Buffer.from(patch, 'latin1');
  const applyArgs =
    scope === 'stage' ? ['apply', '--cached', '-']
    : scope === 'unstage' ? ['apply', '--cached', '--reverse', '-']
    : ['apply', '--reverse', '-']; // discard: worktree の変更を打ち消す(index には触れない)
  await git.runGitInput(dir, applyArgs, patchBuf); // 失敗(非0終了)はそのまま catch -> 500
  res.json({ ok: true });
}

app.post('/api/git/undo-commit', asyncHandler(async (req, res) => {
  await git.undoLastCommit(bodyDir(req));
  res.json({ ok: true });
}));

app.post('/api/git/discard-all', asyncHandler(async (req, res) => {
  await git.discardAll(bodyDir(req), { includeUntracked: req.body.includeUntracked === true });
  res.json({ ok: true });
}));

// 履歴タブから任意コミットへの reset。mode はホワイトリスト外、hash は形式不一致でそれぞれ
// 400 を返す必要があるため asyncHandler (常に 500) ではなく自前で包む
// (POST /api/git/operation と同じパターン)。hash の形式検証 (`/^[0-9a-f]{4,40}$/i`) が
// 引数インジェクションに対する主防壁 (server/git.ts の resetToCommit 参照)。
const RESET_MODES: readonly git.ResetMode[] = ['soft', 'mixed', 'hard'];

app.post('/api/git/reset', (req, res) => {
  handleReset(req, res).catch((err: unknown) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
});

async function handleReset(req: express.Request, res: express.Response): Promise<void> {
  const dir = bodyDir(req);
  const hash = String(req.body.hash ?? '');
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) {
    res.status(400).json({ error: '不正なコミットハッシュです' });
    return;
  }
  const mode = String(req.body.mode ?? '');
  if (!RESET_MODES.includes(mode as git.ResetMode)) {
    res.status(400).json({ error: `不正な mode です: ${mode}` });
    return;
  }
  await git.resetToCommit(dir, hash, mode as git.ResetMode);
  res.json({ ok: true });
}

// 履歴タブから任意コミットの cherry-pick。hash の形式検証は POST /api/git/reset と同じ理由
// (引数インジェクション対策が主目的) で asyncHandler ではなく自前で包む。競合等の git 自身の
// エラーは通常どおり catch -> 500 {error} でよい (作業ツリーは cherry-pick 進行中の状態に
// 入るが、その検出/中止は GET /api/git/status の operation と POST /api/git/operation が担う)。
app.post('/api/git/cherry-pick', (req, res) => {
  handleCherryPick(req, res).catch((err: unknown) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
});

async function handleCherryPick(req: express.Request, res: express.Response): Promise<void> {
  const dir = bodyDir(req);
  const hash = String(req.body.hash ?? '');
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) {
    res.status(400).json({ error: '不正なコミットハッシュです' });
    return;
  }
  await git.cherryPick(dir, hash);
  res.json({ ok: true });
}

// 履歴タブから任意コミットの revert。cherry-pick と同一パターン (hash 形式検証のみ 400、
// 競合等の git 自身のエラー (マージコミットの -m 未指定含む) は catch -> 500 {error})。
app.post('/api/git/revert', (req, res) => {
  handleRevert(req, res).catch((err: unknown) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
});

async function handleRevert(req: express.Request, res: express.Response): Promise<void> {
  const dir = bodyDir(req);
  const hash = String(req.body.hash ?? '');
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) {
    res.status(400).json({ error: '不正なコミットハッシュです' });
    return;
  }
  await git.revertCommit(dir, hash);
  res.json({ ok: true });
}

// ブランチサイドバーから現在のブランチを選択ブランチ (onto) の上に rebase。onto はハッシュと
// 異なり `/` や `.` を含み得るブランチ名のため hash 系のような固定書式検証はできず、先頭 `-`
// のみ 400 で拒否する (引数インジェクション対策の主防壁。server/git.ts の rebaseOnto 参照)。
// この理由で asyncHandler (常に 500) ではなく reset/cherry-pick/revert と同じ自前ラップにする。
// 競合等の git 自身のエラーは通常どおり catch -> 500 {error} でよい (作業ツリーは rebase
// 進行中の状態に入るが、その検出/中止は GET /api/git/status の operation と
// POST /api/git/operation が担う)。
app.post('/api/git/rebase', (req, res) => {
  handleRebase(req, res).catch((err: unknown) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
});

async function handleRebase(req: express.Request, res: express.Response): Promise<void> {
  const dir = bodyDir(req);
  const onto = String(req.body.onto ?? '');
  if (!onto || onto.startsWith('-')) {
    res.status(400).json({ error: `不正な onto です: ${onto}` });
    return;
  }
  await git.rebaseOnto(dir, onto);
  res.json({ ok: true });
}

app.post('/api/git/fetch', asyncHandler(async (req, res) => {
  await git.fetchAll(bodyDir(req));
  res.json({ ok: true });
}));

app.post('/api/git/pull', asyncHandler(async (req, res) => {
  res.json({ result: await git.pull(bodyDir(req), { rebase: req.body.rebase === true }) });
}));

app.post('/api/git/push', asyncHandler(async (req, res) => {
  res.json({
    result: await git.push(bodyDir(req), {
      forceWithLease: req.body.forceWithLease === true,
    }),
  });
}));

app.post('/api/git/switch', asyncHandler(async (req, res) => {
  // track: リモート追跡ブランチ (例: origin/feature/x) から同名ローカルを作成して切り替え。
  // create (-c) とは異なる git switch フラグ (--track) を使うため分岐する。
  if (req.body.track === true) {
    await git.switchBranchTracking(bodyDir(req), String(req.body.branch));
  } else {
    await git.switchBranch(bodyDir(req), String(req.body.branch), req.body.create === true);
  }
  res.json({ ok: true });
}));

app.post('/api/git/branch-delete', asyncHandler(async (req, res) => {
  await git.deleteBranch(bodyDir(req), String(req.body.branch), req.body.force === true);
  res.json({ ok: true });
}));

// branch-delete (ローカル、git branch -d/-D、瞬時) とは基盤コマンドもリクエスト形状も
// 異なるネットワーク操作 (git push --delete) のため、フラグ拡張ではなく新ルートにする。
app.post('/api/git/branch-delete-remote', asyncHandler(async (req, res) => {
  await git.deleteRemoteBranch(bodyDir(req), String(req.body.remoteBranch));
  res.json({ ok: true });
}));

app.post('/api/git/branch-rename', asyncHandler(async (req, res) => {
  await git.renameBranch(bodyDir(req), String(req.body.oldName), String(req.body.newName));
  res.json({ ok: true });
}));

app.get('/api/git/remotes', asyncHandler(async (req, res) => {
  const dir = requireKnownDir(req);
  res.json(await git.listRemotes(dir));
}));

app.post('/api/git/remote-add', asyncHandler(async (req, res) => {
  await git.addRemote(bodyDir(req), String(req.body.name ?? ''), String(req.body.url ?? ''));
  res.json({ ok: true });
}));

app.post('/api/git/remote-remove', asyncHandler(async (req, res) => {
  await git.removeRemote(bodyDir(req), String(req.body.name ?? ''));
  res.json({ ok: true });
}));

app.post('/api/git/remote-set-url', asyncHandler(async (req, res) => {
  await git.setRemoteUrl(bodyDir(req), String(req.body.name ?? ''), String(req.body.url ?? ''));
  res.json({ ok: true });
}));

// branch の空/先頭 `-` ガードは reviewer 指摘 (5.R) による予防的追加 — 現行 git では単独オプション
// は引数不足エラー、strategy 系は値自体が検証されるため実害は実証されていないが、Phase 5 で
// 新設した reset/cherry-pick/revert/rebase の 4 ルートと型を揃える (多層防御・一貫性)。
// この理由で asyncHandler (常に 500) ではなく同型の自前ラップにする。マージ本体・成功パスは
// 無変更。
app.post('/api/git/merge', (req, res) => {
  handleMerge(req, res).catch((err: unknown) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
});

async function handleMerge(req: express.Request, res: express.Response): Promise<void> {
  const dir = bodyDir(req);
  const branch = String(req.body.branch ?? '');
  if (!branch || branch.startsWith('-')) {
    res.status(400).json({ error: `不正な branch です: ${branch}` });
    return;
  }
  const { noFf, ffOnly, message } = req.body ?? {};
  res.json({
    result: await git.merge(dir, branch, {
      noFf: !!noFf,
      ffOnly: !!ffOnly,
      message: typeof message === 'string' && message ? message : undefined,
    }),
  });
}

app.post('/api/git/merge-abort', asyncHandler(async (req, res) => {
  await git.mergeAbort(bodyDir(req));
  res.json({ ok: true });
}));

// 進行中操作 (merge/rebase/cherry-pick/revert) の continue/abort/skip。kind/action は
// ホワイトリスト外を弾いて 400 を返す必要があるため、asyncHandler(常に 500)は使わず
// POST /api/git/apply-hunks と同様に自前で包む。
const OPERATION_KINDS: readonly git.GitOperation[] = ['merge', 'rebase', 'cherry-pick', 'revert'];
const OPERATION_ACTIONS: readonly git.GitOperationAction[] = ['continue', 'abort', 'skip'];

app.post('/api/git/operation', (req, res) => {
  handleOperationAction(req, res).catch((err: unknown) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
});

async function handleOperationAction(req: express.Request, res: express.Response): Promise<void> {
  const dir = bodyDir(req);
  const kind = String(req.body.kind ?? '');
  const action = String(req.body.action ?? '');
  if (!OPERATION_KINDS.includes(kind as git.GitOperation)) {
    res.status(400).json({ error: `不正な kind です: ${kind}` });
    return;
  }
  if (!OPERATION_ACTIONS.includes(action as git.GitOperationAction)) {
    res.status(400).json({ error: `不正な action です: ${action}` });
    return;
  }
  if (action === 'skip' && kind === 'merge') {
    res.status(400).json({ error: 'merge に --skip は存在しません' });
    return;
  }
  await git.operationAction(dir, kind as git.GitOperation, action as git.GitOperationAction);
  res.json({ ok: true });
}

// 競合ファイルの ours/theirs 採用。side は operation 同様ホワイトリスト外を 400 で弾く必要が
// あるため asyncHandler は使わず自前で包む。
const CONFLICT_SIDES: readonly git.ConflictSide[] = ['ours', 'theirs'];

app.post('/api/git/resolve-side', (req, res) => {
  handleResolveSide(req, res).catch((err: unknown) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
});

async function handleResolveSide(req: express.Request, res: express.Response): Promise<void> {
  const dir = bodyDir(req);
  const filePath = String(req.body.path ?? '');
  if (!filePath) throw new Error('path が必要です');
  const side = String(req.body.side ?? '');
  if (!CONFLICT_SIDES.includes(side as git.ConflictSide)) {
    res.status(400).json({ error: `不正な side です: ${side}` });
    return;
  }
  await git.resolveConflictSide(dir, filePath, side as git.ConflictSide);
  res.json({ ok: true });
}

app.get('/api/git/stash', asyncHandler(async (req, res) => {
  res.json(await git.stashList(requireKnownDir(req)));
}));

app.post('/api/git/stash', asyncHandler(async (req, res) => {
  await git.stashPush(
    bodyDir(req),
    typeof req.body.message === 'string' && req.body.message ? req.body.message : undefined,
    req.body.includeUntracked !== false,
  );
  res.json({ ok: true });
}));

app.post('/api/git/stash-apply', asyncHandler(async (req, res) => {
  await git.stashApply(bodyDir(req), String(req.body.ref), req.body.pop === true);
  res.json({ ok: true });
}));

app.post('/api/git/stash-drop', asyncHandler(async (req, res) => {
  await git.stashDrop(bodyDir(req), String(req.body.ref));
  res.json({ ok: true });
}));

// ---- file system -----------------------------------------------------------

app.get('/api/fs/tree', asyncHandler(async (req, res) => {
  const root = queryStr(req, 'root');
  const dir = typeof req.query.dir === 'string' ? req.query.dir : '';
  res.json(files.listDir(root, dir));
}));

app.get('/api/fs/file', asyncHandler(async (req, res) => {
  const encoding = typeof req.query.encoding === 'string' && req.query.encoding ? req.query.encoding : undefined;
  res.json(files.readFileContent(queryStr(req, 'root'), queryStr(req, 'path'), encoding));
}));

app.put('/api/fs/file', asyncHandler(async (req, res) => {
  const { root, path: rel, content, encoding, bom } = req.body as {
    root: string;
    path: string;
    content: string;
    encoding?: string;
    bom?: boolean;
  };
  if (typeof content !== 'string') throw new Error('content が必要です');
  files.writeFileContent(root, rel, content, typeof encoding === 'string' ? encoding : undefined, bom === true);
  res.json({ ok: true });
}));

app.post('/api/fs/file', asyncHandler(async (req, res) => {
  const { root, path: rel } = req.body as { root: string; path: string };
  if (!rel) throw new Error('path が必要です');
  files.createFile(root, rel);
  res.json({ ok: true });
}));

app.post('/api/fs/dir', asyncHandler(async (req, res) => {
  const { root, path: rel } = req.body as { root: string; path: string };
  if (!rel) throw new Error('path が必要です');
  files.createDir(root, rel);
  res.json({ ok: true });
}));

app.get('/api/fs/git-status', asyncHandler(async (req, res) => {
  const root = queryStr(req, 'root');
  const gitRoot = git.resolveGitRoot(root);
  if (!gitRoot) { res.json([]); return; } // none → 全て白(従来挙動)
  try {
    const entries = await git.getTreeStatus(gitRoot);
    if (gitRoot === root) { res.json(entries); return; }
    // subdir: repo 全体分から登録ディレクトリー配下だけを切り出し、パスを subdir 相対にする
    const prefix = path.relative(gitRoot, root).replace(/\\/g, '/') + '/';
    res.json(entries.flatMap((e) =>
      e.path.startsWith(prefix) ? [{ ...e, path: e.path.slice(prefix.length) }] : []));
  } catch {
    res.json([]); // non-git directory etc. → empty (everything renders white)
  }
}));

// ---- code search -------------------------------------------------------------

app.get('/api/search/files', asyncHandler(async (req, res) => {
  const root = queryStr(req, 'root');
  if (!fs.existsSync(root)) throw new Error(`ディレクトリーが存在しません: ${root}`);
  const files = git.resolveGitRoot(root)
    ? await git.listFiles(root)      // root/subdir: ls-files は cwd 相対・cwd 配下のみ
    : await search.listFilesRg(root); // none のみ rg フォールバック
  res.json({ files });
}));

app.get('/api/search/text', asyncHandler(async (req, res) => {
  const root = queryStr(req, 'root');
  if (!fs.existsSync(root)) throw new Error(`ディレクトリーが存在しません: ${root}`);
  const q = queryStr(req, 'q');
  const running = search.searchText(root, q, {
    regex: req.query.regex === '1',
    caseSensitive: req.query.case === '1',
    maxResults: Math.min(Number(req.query.max) || 500, 2000),
  });
  // クライアントが AbortController で接続を切ったら rg を止める(連打対策)
  res.on('close', () => {
    if (!res.writableEnded) running.cancel();
  });
  res.json(await running.promise);
}));

// ---- terminals ---------------------------------------------------------------

app.get('/api/terminals', asyncHandler(async (req, res) => {
  res.json(ptyManager.list(typeof req.query.cwd === 'string' ? req.query.cwd : undefined));
}));

app.post('/api/terminals', asyncHandler(async (req, res) => {
  const cwd = String(req.body.cwd ?? '');
  if (!fs.existsSync(cwd)) throw new Error(`ディレクトリーが存在しません: ${cwd}`);
  const run = typeof req.body.run === 'string' && req.body.run ? req.body.run : undefined;
  res.json(ptyManager.create(cwd, run));
}));

app.post('/api/terminals/:id/kill', asyncHandler(async (req, res) => {
  res.json({ ok: ptyManager.kill(req.params.id) });
}));

// Claude Code の hooks (deck-hook.mjs) からのイベント通知。127.0.0.1 バインドの
// ためローカルプロセスのみ到達できる。未知のターミナル id は黙って無視する
// (セッション終了とフック POST のレースで普通に起きる)。
app.post('/api/agent-events', asyncHandler(async (req, res) => {
  const { term, event, message, notificationType } = req.body as {
    term?: string;
    event?: string;
    message?: string;
    notificationType?: string;
  };
  if (typeof term !== 'string' || typeof event !== 'string') {
    throw new Error('term と event が必要です');
  }
  res.json({
    ok: ptyManager.applyHookEvent(
      term,
      event,
      typeof message === 'string' ? message : '',
      typeof notificationType === 'string' ? notificationType : '',
    ),
  });
}));

// ---- static client (production build) ---------------------------------------

// Resolve the built client for both layouts:
//   dev:      server/index.ts      -> ../client/dist
//   packaged: dist/server/index.js -> ../../client/dist
const clientDist = [
  path.resolve(__dirname, '../client/dist'),
  path.resolve(__dirname, '../../client/dist'),
].find((p) => fs.existsSync(path.join(p, 'index.html')));
if (clientDist) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// ---- error handling ----------------------------------------------------------

// 最終防波堤: asyncHandler の網から漏れた同期 throw や body-parser のエラーを
// JSON 500 に統一する。4 引数シグネチャが Express にエラーミドルウェアとして
// 認識される条件のため _next を省略しない。
app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[claude-deck3] request error:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  },
);

// ---- server + websocket ------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  if (url.pathname === '/ws/term') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const id = url.searchParams.get('id') ?? '';
      if (!ptyManager.attach(id, ws)) {
        ws.send(JSON.stringify({ type: 'error', message: 'ターミナルが見つかりません' }));
        ws.close();
      }
    });
  } else if (url.pathname === '/ws/events') {
    // 全セッションのステータス変化を購読するグローバルチャンネル (通知・要対応キュー用)
    wss.handleUpgrade(req, socket, head, (ws) => ptyManager.attachEvents(ws));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[claude-deck3] server: http://localhost:${PORT}`);
  console.log(`[claude-deck3] mode: ${process.env.NODE_ENV ?? 'development'}`);
});
