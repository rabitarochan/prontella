import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const US = '\x1f'; // unit separator for log formatting
export function runGit(cwd, args, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
        execFile('git', args, {
            cwd,
            maxBuffer: 64 * 1024 * 1024,
            windowsHide: true,
            timeout: timeoutMs,
            // Fail fast instead of hanging when a remote asks for credentials.
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        }, (err, stdout, stderr) => {
            if (err)
                reject(new Error(stderr.trim() || err.message));
            else
                resolve(stdout);
        });
    });
}
const NETWORK_TIMEOUT = 120_000;
export async function listWorktrees(repoPath) {
    const out = await runGit(repoPath, ['worktree', 'list', '--porcelain']);
    const worktrees = [];
    let current = null;
    for (const line of out.split('\n')) {
        if (line.startsWith('worktree ')) {
            if (current?.path)
                worktrees.push(finishWorktree(current));
            current = { path: path.resolve(line.slice('worktree '.length)) };
        }
        else if (line.startsWith('HEAD ') && current) {
            current.head = line.slice(5, 12);
        }
        else if (line.startsWith('branch ') && current) {
            current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
        }
        else if (line.startsWith('locked') && current) {
            current.locked = true;
        }
    }
    if (current?.path)
        worktrees.push(finishWorktree(current));
    if (worktrees.length > 0)
        worktrees[0].isMain = true;
    return worktrees;
}
function finishWorktree(partial) {
    return {
        path: partial.path ?? '',
        head: partial.head ?? '',
        branch: partial.branch ?? null,
        isMain: false,
        locked: partial.locked ?? false,
    };
}
export async function getBranchStatus(dir) {
    const out = await runGit(dir, ['status', '--porcelain=v2', '--branch']);
    const status = {
        branch: '(detached)',
        upstream: null,
        ahead: 0,
        behind: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicted: 0,
    };
    for (const line of out.split('\n')) {
        if (line.startsWith('# branch.head ')) {
            status.branch = line.slice('# branch.head '.length);
        }
        else if (line.startsWith('# branch.upstream ')) {
            status.upstream = line.slice('# branch.upstream '.length);
        }
        else if (line.startsWith('# branch.ab ')) {
            const m = line.match(/\+(\d+) -(\d+)/);
            if (m) {
                status.ahead = Number(m[1]);
                status.behind = Number(m[2]);
            }
        }
        else if (line.startsWith('1 ') || line.startsWith('2 ')) {
            const xy = line.slice(2, 4);
            if (xy[0] !== '.')
                status.staged++;
            if (xy[1] !== '.')
                status.unstaged++;
        }
        else if (line.startsWith('u ')) {
            status.conflicted++;
        }
        else if (line.startsWith('? ')) {
            status.untracked++;
        }
    }
    return status;
}
export async function getStatusFiles(dir) {
    const out = await runGit(dir, ['status', '--porcelain=v2']);
    const files = [];
    for (const line of out.split('\n')) {
        if (line.startsWith('1 ')) {
            const parts = line.split(' ');
            const xy = parts[1];
            files.push({
                path: parts.slice(8).join(' '),
                origPath: null,
                staged: xy[0],
                unstaged: xy[1],
                untracked: false,
                conflicted: false,
            });
        }
        else if (line.startsWith('2 ')) {
            // rename/copy: "2 XY sub mH mI mW hH hI X<score> path<TAB>origPath"
            const parts = line.split(' ');
            const xy = parts[1];
            const pathPart = parts.slice(9).join(' ');
            const [newPath, origPath] = pathPart.split('\t');
            files.push({
                path: newPath,
                origPath: origPath ?? null,
                staged: xy[0],
                unstaged: xy[1],
                untracked: false,
                conflicted: false,
            });
        }
        else if (line.startsWith('u ')) {
            const parts = line.split(' ');
            files.push({
                path: parts.slice(10).join(' '),
                origPath: null,
                staged: 'U',
                unstaged: 'U',
                untracked: false,
                conflicted: true,
            });
        }
        else if (line.startsWith('? ')) {
            files.push({
                path: line.slice(2),
                origPath: null,
                staged: '.',
                unstaged: '?',
                untracked: true,
                conflicted: false,
            });
        }
    }
    return files;
}
export async function getLog(dir, limit = 100, ref) {
    const format = ['%H', '%h', '%an', '%aI', '%s', '%D'].join(US);
    const args = ['log', `--pretty=format:${format}`, `-n`, String(limit)];
    if (ref)
        args.push(ref);
    let out;
    try {
        out = await runGit(dir, args);
    }
    catch (e) {
        // empty repository (no commits yet)
        if (String(e).includes('does not have any commits'))
            return [];
        throw e;
    }
    return out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
        const [hash, shortHash, author, date, subject, refs] = line.split(US);
        return { hash, shortHash, author, date, subject, refs: refs ?? '' };
    });
}
export async function getCommitDetail(dir, hash) {
    return runGit(dir, ['show', '--patch', '--stat', '--format=fuller', hash]);
}
export async function getCommitFiles(dir, hash) {
    const out = await runGit(dir, ['show', '--name-status', '--format=', '-M', hash]);
    const files = [];
    for (const line of out.split('\n')) {
        if (!line.trim())
            continue;
        const parts = line.split('\t');
        const status = parts[0][0];
        if (status === 'R' || status === 'C') {
            files.push({ path: parts[2], origPath: parts[1], status });
        }
        else {
            files.push({ path: parts[1], origPath: null, status });
        }
    }
    return files;
}
/** Content of a file at a revision (e.g. "HEAD", ":0" for the index), or null if absent. */
export async function getFileAtRev(dir, rev, filePath) {
    try {
        return await runGit(dir, ['show', `${rev}:${filePath}`]);
    }
    catch {
        return null; // added/deleted at this revision, or outside the tree
    }
}
export async function getDiff(dir, opts) {
    if (opts.untracked && opts.path) {
        // synthesize an "added file" patch for untracked files
        const abs = path.join(dir, opts.path);
        const stat = fs.statSync(abs);
        if (stat.size > 1024 * 1024)
            return `(新規ファイル: ${opts.path} — 1MB を超えるため省略)`;
        const content = fs.readFileSync(abs);
        if (content.includes(0))
            return `(新規バイナリファイル: ${opts.path})`;
        const lines = content.toString('utf8').split('\n');
        const body = lines.map((l) => `+${l}`).join('\n');
        return `diff --git a/${opts.path} b/${opts.path}\nnew file\n--- /dev/null\n+++ b/${opts.path}\n@@ -0,0 +1,${lines.length} @@\n${body}`;
    }
    const args = ['diff'];
    if (opts.staged)
        args.push('--cached');
    if (opts.path)
        args.push('--', opts.path);
    return runGit(dir, args);
}
export async function listBranches(repoPath) {
    const format = ['%(refname)', '%(refname:short)', '%(objectname:short)', '%(HEAD)', '%(worktreepath)'].join(US);
    const out = await runGit(repoPath, ['branch', '-a', `--format=${format}`]);
    return out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
        const [refname, name, hash, head, worktreePath] = line.split(US);
        return {
            name,
            hash,
            current: head === '*',
            remote: refname.startsWith('refs/remotes/'),
            worktreePath: worktreePath || null,
        };
    })
        .filter((b) => !b.name.endsWith('/HEAD'));
}
export async function addWorktree(repoPath, worktreePath, opts) {
    const args = ['worktree', 'add'];
    if (opts.newBranch) {
        args.push('-b', opts.newBranch, worktreePath);
        if (opts.base)
            args.push(opts.base);
    }
    else if (opts.branch) {
        args.push(worktreePath, opts.branch);
    }
    else {
        args.push(worktreePath);
    }
    await runGit(repoPath, args);
}
export async function removeWorktree(repoPath, worktreePath, force) {
    const args = ['worktree', 'remove'];
    if (force)
        args.push('--force');
    args.push(worktreePath);
    await runGit(repoPath, args);
}
export async function stageFile(dir, filePath) {
    await runGit(dir, ['add', '--', filePath]);
}
export async function unstageFile(dir, filePath) {
    await runGit(dir, ['restore', '--staged', '--', filePath]);
}
export async function stageAll(dir) {
    await runGit(dir, ['add', '-A']);
}
export async function unstageAll(dir) {
    await runGit(dir, ['reset']);
}
/** Discard working-tree changes of a tracked file (restores from the index). */
export async function discardFile(dir, filePath) {
    await runGit(dir, ['restore', '--', filePath]);
}
export async function commit(dir, message, amend = false) {
    const args = ['commit', '-m', message];
    if (amend)
        args.push('--amend');
    await runGit(dir, args);
    return runGit(dir, ['log', '-1', '--pretty=format:%h %s']);
}
// ---- sync -------------------------------------------------------------------
export async function fetchAll(dir) {
    await runGit(dir, ['fetch', '--all', '--prune'], NETWORK_TIMEOUT);
}
export async function pull(dir) {
    return runGit(dir, ['pull'], NETWORK_TIMEOUT);
}
export async function push(dir) {
    try {
        await runGit(dir, ['rev-parse', '--abbrev-ref', '@{u}']);
        return await runGit(dir, ['push'], NETWORK_TIMEOUT);
    }
    catch {
        // no upstream yet -> publish the current branch
        return runGit(dir, ['push', '-u', 'origin', 'HEAD'], NETWORK_TIMEOUT);
    }
}
// ---- branches ---------------------------------------------------------------
export async function switchBranch(dir, branch, create = false) {
    const args = ['switch'];
    if (create)
        args.push('-c');
    args.push(branch);
    await runGit(dir, args);
}
export async function deleteBranch(repoPath, branch, force = false) {
    await runGit(repoPath, ['branch', force ? '-D' : '-d', branch]);
}
export async function merge(dir, branch) {
    return runGit(dir, ['merge', '--no-edit', branch]);
}
export async function mergeAbort(dir) {
    await runGit(dir, ['merge', '--abort']);
}
export async function isMerging(dir) {
    try {
        await runGit(dir, ['rev-parse', '--verify', '-q', 'MERGE_HEAD']);
        return true;
    }
    catch {
        return false;
    }
}
export async function stashList(dir) {
    const out = await runGit(dir, ['stash', 'list', `--format=%gd${US}%s`]);
    return out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
        const [ref, message] = line.split(US);
        return { ref, message };
    });
}
export async function stashPush(dir, message, includeUntracked = true) {
    const args = ['stash', 'push'];
    if (includeUntracked)
        args.push('-u');
    if (message)
        args.push('-m', message);
    await runGit(dir, args);
}
export async function stashApply(dir, ref, pop) {
    if (!/^stash@\{\d+\}$/.test(ref))
        throw new Error(`不正な stash 参照です: ${ref}`);
    await runGit(dir, ['stash', pop ? 'pop' : 'apply', ref]);
}
export async function stashDrop(dir, ref) {
    if (!/^stash@\{\d+\}$/.test(ref))
        throw new Error(`不正な stash 参照です: ${ref}`);
    await runGit(dir, ['stash', 'drop', ref]);
}
