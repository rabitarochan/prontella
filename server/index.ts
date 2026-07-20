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

app.post('/api/git/fetch', asyncHandler(async (req, res) => {
  await git.fetchAll(bodyDir(req));
  res.json({ ok: true });
}));

app.post('/api/git/pull', asyncHandler(async (req, res) => {
  res.json({ result: await git.pull(bodyDir(req)) });
}));

app.post('/api/git/push', asyncHandler(async (req, res) => {
  res.json({ result: await git.push(bodyDir(req)) });
}));

app.post('/api/git/switch', asyncHandler(async (req, res) => {
  await git.switchBranch(bodyDir(req), String(req.body.branch), req.body.create === true);
  res.json({ ok: true });
}));

app.post('/api/git/branch-delete', asyncHandler(async (req, res) => {
  await git.deleteBranch(bodyDir(req), String(req.body.branch), req.body.force === true);
  res.json({ ok: true });
}));

app.post('/api/git/merge', asyncHandler(async (req, res) => {
  res.json({ result: await git.merge(bodyDir(req), String(req.body.branch)) });
}));

app.post('/api/git/merge-abort', asyncHandler(async (req, res) => {
  await git.mergeAbort(bodyDir(req));
  res.json({ ok: true });
}));

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
