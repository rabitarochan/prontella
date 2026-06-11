import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const CONFIG_DIR = path.join(os.homedir(), '.claude-deck3');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export function repoId(repoPath) {
    return Buffer.from(path.resolve(repoPath)).toString('base64url');
}
export function loadConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.repos))
            return parsed;
    }
    catch {
        // missing or corrupt -> fresh config
    }
    return { repos: [] };
}
export function saveConfig(config) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}
export function addRepo(repoPath) {
    const resolved = path.resolve(repoPath);
    if (!fs.existsSync(path.join(resolved, '.git'))) {
        throw new Error(`Git リポジトリーではありません: ${resolved}`);
    }
    const config = loadConfig();
    const id = repoId(resolved);
    const existing = config.repos.find((r) => r.id === id);
    if (existing)
        return existing;
    const repo = { id, path: resolved, name: path.basename(resolved) };
    config.repos.push(repo);
    saveConfig(config);
    return repo;
}
export function removeRepo(id) {
    const config = loadConfig();
    config.repos = config.repos.filter((r) => r.id !== id);
    saveConfig(config);
}
export function getRepo(id) {
    return loadConfig().repos.find((r) => r.id === id);
}
