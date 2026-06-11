import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import * as config from './config.js';
import * as git from './git.js';
import * as files from './files.js';
import { PtyManager } from './pty.js';
const PORT = Number(process.env.PORT) || 3711;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '10mb' }));
const ptyManager = new PtyManager();
function asyncHandler(fn) {
    return (req, res) => {
        fn(req, res).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            res.status(500).json({ error: message });
        });
    };
}
function requireRepo(req) {
    const repo = config.getRepo(req.params.id);
    if (!repo)
        throw new Error('リポジトリーが見つかりません');
    return repo;
}
function queryStr(req, name) {
    const value = req.query[name];
    if (typeof value !== 'string' || !value)
        throw new Error(`クエリパラメーター ${name} が必要です`);
    return value;
}
// ---- repos -----------------------------------------------------------------
app.get('/api/repos', asyncHandler(async (_req, res) => {
    const { repos } = config.loadConfig();
    const result = await Promise.all(repos.map(async (repo) => {
        try {
            const worktrees = await git.listWorktrees(repo.path);
            const detailed = await Promise.all(worktrees.map(async (wt) => {
                let status = null;
                try {
                    status = await git.getBranchStatus(wt.path);
                }
                catch {
                    // worktree directory may be missing/prunable
                }
                return { ...wt, status, agent: ptyManager.statusFor(wt.path) };
            }));
            return { ...repo, worktrees: detailed, error: null };
        }
        catch (e) {
            return { ...repo, worktrees: [], error: e instanceof Error ? e.message : String(e) };
        }
    }));
    res.json(result);
}));
app.post('/api/repos', asyncHandler(async (req, res) => {
    const repoPath = String(req.body.path ?? '');
    if (!repoPath)
        throw new Error('path が必要です');
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
    const { branch, newBranch, base } = req.body;
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
function requireKnownDir(req) {
    const dir = queryStr(req, 'dir');
    if (!fs.existsSync(dir))
        throw new Error(`ディレクトリーが存在しません: ${dir}`);
    return dir;
}
app.get('/api/git/log', asyncHandler(async (req, res) => {
    const dir = requireKnownDir(req);
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(await git.getLog(dir, limit, typeof req.query.ref === 'string' ? req.query.ref : undefined));
}));
app.get('/api/git/commit', asyncHandler(async (req, res) => {
    const dir = requireKnownDir(req);
    const hash = queryStr(req, 'hash');
    if (!/^[0-9a-f]{4,40}$/i.test(hash))
        throw new Error('不正なコミットハッシュです');
    res.json({ text: await git.getCommitDetail(dir, hash) });
}));
app.get('/api/git/status', asyncHandler(async (req, res) => {
    const dir = requireKnownDir(req);
    res.json({
        branch: await git.getBranchStatus(dir),
        files: await git.getStatusFiles(dir),
        merging: await git.isMerging(dir),
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
    let original;
    let modified;
    if (scope === 'commit') {
        const hash = queryStr(req, 'hash');
        if (!/^[0-9a-f]{4,40}$/i.test(hash))
            throw new Error('不正なコミットハッシュです');
        original = await git.getFileAtRev(dir, `${hash}^`, origPath);
        modified = await git.getFileAtRev(dir, hash, filePath);
    }
    else if (scope === 'staged') {
        original = await git.getFileAtRev(dir, 'HEAD', origPath);
        modified = await git.getFileAtRev(dir, ':0', filePath);
    }
    else if (scope === 'worktree') {
        original = await git.getFileAtRev(dir, ':0', origPath);
        try {
            modified = fs.readFileSync(path.join(dir, filePath), 'utf8');
        }
        catch {
            modified = null; // deleted from the working tree
        }
    }
    else {
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
    if (!/^[0-9a-f]{4,40}$/i.test(hash))
        throw new Error('不正なコミットハッシュです');
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
    await git.stageFile(String(req.body.dir), String(req.body.path));
    res.json({ ok: true });
}));
app.post('/api/git/unstage', asyncHandler(async (req, res) => {
    await git.unstageFile(String(req.body.dir), String(req.body.path));
    res.json({ ok: true });
}));
app.post('/api/git/commit', asyncHandler(async (req, res) => {
    const message = String(req.body.message ?? '').trim();
    if (!message)
        throw new Error('コミットメッセージが必要です');
    res.json({ result: await git.commit(String(req.body.dir), message, req.body.amend === true) });
}));
function bodyDir(req) {
    const dir = String(req.body.dir ?? '');
    if (!dir || !fs.existsSync(dir))
        throw new Error(`ディレクトリーが存在しません: ${dir}`);
    return dir;
}
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
    if (!filePath)
        throw new Error('path が必要です');
    if (req.body.untracked === true) {
        fs.rmSync(files.safeResolve(dir, filePath), { force: true });
    }
    else {
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
    await git.stashPush(bodyDir(req), typeof req.body.message === 'string' && req.body.message ? req.body.message : undefined, req.body.includeUntracked !== false);
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
    res.json(files.readFileContent(queryStr(req, 'root'), queryStr(req, 'path')));
}));
app.put('/api/fs/file', asyncHandler(async (req, res) => {
    const { root, path: rel, content } = req.body;
    if (typeof content !== 'string')
        throw new Error('content が必要です');
    files.writeFileContent(root, rel, content);
    res.json({ ok: true });
}));
// ---- terminals ---------------------------------------------------------------
app.get('/api/terminals', asyncHandler(async (req, res) => {
    res.json(ptyManager.list(typeof req.query.cwd === 'string' ? req.query.cwd : undefined));
}));
app.post('/api/terminals', asyncHandler(async (req, res) => {
    const cwd = String(req.body.cwd ?? '');
    if (!fs.existsSync(cwd))
        throw new Error(`ディレクトリーが存在しません: ${cwd}`);
    const run = typeof req.body.run === 'string' && req.body.run ? req.body.run : undefined;
    res.json(ptyManager.create(cwd, run));
}));
app.post('/api/terminals/:id/kill', asyncHandler(async (req, res) => {
    res.json({ ok: ptyManager.kill(req.params.id) });
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
// ---- server + websocket ------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== '/ws/term') {
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
        const id = url.searchParams.get('id') ?? '';
        if (!ptyManager.attach(id, ws)) {
            ws.send(JSON.stringify({ type: 'error', message: 'ターミナルが見つかりません' }));
            ws.close();
        }
    });
});
server.listen(PORT, '127.0.0.1', () => {
    console.log(`[claude-deck3] server: http://localhost:${PORT}`);
    console.log(`[claude-deck3] mode: ${process.env.NODE_ENV ?? 'development'}`);
});
