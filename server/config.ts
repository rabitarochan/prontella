import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface RepoConfig {
  id: string;
  path: string;
  name: string;
}

interface DeckConfig {
  repos: RepoConfig[];
}

const CONFIG_DIR = path.join(os.homedir(), '.claude-deck3');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function repoId(repoPath: string): string {
  return Buffer.from(path.resolve(repoPath)).toString('base64url');
}

export function loadConfig(): DeckConfig {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw) as DeckConfig;
    if (Array.isArray(parsed.repos)) return parsed;
  } catch {
    // missing or corrupt -> fresh config
  }
  return { repos: [] };
}

export function saveConfig(config: DeckConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

export function addRepo(repoPath: string): RepoConfig {
  const resolved = path.resolve(repoPath);
  let stat: fs.Stats;
  try { stat = fs.statSync(resolved); }
  catch { throw new Error(`ディレクトリーが存在しません: ${resolved}`); }
  if (!stat.isDirectory()) throw new Error(`ディレクトリーではありません: ${resolved}`);
  const config = loadConfig();
  const id = repoId(resolved);
  const existing = config.repos.find((r) => r.id === id);
  if (existing) return existing;
  const repo: RepoConfig = { id, path: resolved, name: path.basename(resolved) };
  config.repos.push(repo);
  saveConfig(config);
  return repo;
}

export function removeRepo(id: string): void {
  const config = loadConfig();
  config.repos = config.repos.filter((r) => r.id !== id);
  saveConfig(config);
}

export function getRepo(id: string): RepoConfig | undefined {
  return loadConfig().repos.find((r) => r.id === id);
}
