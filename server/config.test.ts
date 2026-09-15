import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worktreeDefaultPath, writeJsonAtomic } from './config.js';

// writeJsonAtomic は os.tmpdir() 配下の使い捨てディレクトリーに対してのみテストする。
// 実 `~/.prontella/config.json` には絶対に触れない(loadConfig/saveConfig 自体はここでは
// テストしない — CONFIG_FILE がモジュールスコープの定数で os.homedir() 固定のため、テストで
// 呼ぶと実設定を読み書きしてしまう)。
describe('writeJsonAtomic', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prontella-writeJsonAtomic-'));
    file = path.join(dir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a new file with valid JSON content', () => {
    writeJsonAtomic(file, { repos: [{ id: 'a', path: '/a', name: 'A' }] });
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      repos: [{ id: 'a', path: '/a', name: 'A' }],
    });
  });

  it('overwrites an existing file', () => {
    writeJsonAtomic(file, { repos: [] });
    writeJsonAtomic(file, { repos: [{ id: 'b', path: '/b', name: 'B' }] });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      repos: [{ id: 'b', path: '/b', name: 'B' }],
    });
  });

  it('does not leave a .tmp file behind after a successful write', () => {
    writeJsonAtomic(file, { repos: [] });
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });

  it('never leaves the target file containing invalid JSON, across repeated writes', () => {
    for (let i = 0; i < 5; i++) {
      writeJsonAtomic(file, { repos: [], n: i });
      expect(() => JSON.parse(fs.readFileSync(file, 'utf8'))).not.toThrow();
    }
  });

  it('creates the parent directory if it does not exist yet', () => {
    const nested = path.join(dir, 'nested', 'sub', 'config.json');
    writeJsonAtomic(nested, { repos: [] });
    expect(fs.existsSync(nested)).toBe(true);
    expect(JSON.parse(fs.readFileSync(nested, 'utf8'))).toEqual({ repos: [] });
  });
});

// loadConfig/saveConfig は CONFIG_FILE = os.homedir()/.prontella/config.json をモジュール
// スコープの定数として固定しているため、実 config に触れずにテストするには os.homedir() の
// 解決先そのものを差し替える必要がある。Windows の os.homedir() は process.env.USERPROFILE を
// 都度読むため(実測済み)、それを隔離ディレクトリーに差し替えたうえで vi.resetModules() +
// 動的 import で config.ts を再評価させ、フレッシュな CONFIG_FILE を持つモジュールインスタンスを
// 得る(静的 import だとこのファイルの他の記述より先にモジュール本体が実行されてしまうため、
// 差し替えが間に合わない)。
describe('loadConfig / saveConfig (隔離 home, 実 config 非接触)', () => {
  let isolatedHome: string;
  let configDir: string;
  let configFile: string;
  let originalUserProfile: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'prontella-config-home-'));
    configDir = path.join(isolatedHome, '.prontella');
    configFile = path.join(configDir, 'config.json');
    originalUserProfile = process.env.USERPROFILE;
    originalHome = process.env.HOME;
    process.env.USERPROFILE = isolatedHome;
    process.env.HOME = isolatedHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(isolatedHome, { recursive: true, force: true });
    vi.resetModules();
  });

  async function freshConfigModule() {
    return import('./config.js');
  }

  it('パース失敗で退避したら、同一プロセス内の 2 回目以降の loadConfig も投げ続ける({repos:[]}を返さない)', async () => {
    const configModule = await freshConfigModule();
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configFile, '{not valid json', 'utf8');

    // 1 回目: パース失敗 → 退避 → rethrow
    expect(() => configModule.loadConfig()).toThrow();
    expect(fs.existsSync(configFile)).toBe(false); // rename 済みで元ファイルは消えている
    const corruptFiles = fs.readdirSync(configDir).filter((f) => f.includes('.corrupt-'));
    expect(corruptFiles).toHaveLength(1);

    // 2 回目・3 回目: 元ファイルは無い(ENOENT になり得る状況)が、{repos:[]} を返さず投げ続ける
    expect(() => configModule.loadConfig()).toThrow();
    expect(() => configModule.loadConfig()).toThrow();
  });

  it('トップレベルの未知キーが loadConfig→saveConfig の往復(setRepoFlags/reorderRepos 経由含む)で保持される', async () => {
    const configModule = await freshConfigModule();
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      configFile,
      JSON.stringify({ repos: [{ id: 'a', path: '/a', name: 'A' }], futureTopLevelFlag: 'kept' }),
      'utf8',
    );

    const loaded = configModule.loadConfig();
    expect(loaded.futureTopLevelFlag).toBe('kept');
    // normalizeRepoConfig は id を常に path から再導出するため、書いた 'a' そのままではない
    // (server/repoOrder.ts の normalizeRepoConfig 参照)。以降はこの実 id を使う。
    const actualId = loaded.repos[0].id;
    expect(actualId).not.toBe('a');

    // 素朴な load→save 往復
    configModule.saveConfig(loaded);
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8')).futureTopLevelFlag).toBe('kept');

    // PUT /api/repos/order 相当(reorderRepos)を経由しても保持されること(報告された回帰の再現経路)
    const reorderResult = configModule.reorderRepos([actualId]);
    expect(reorderResult.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8')).futureTopLevelFlag).toBe('kept');

    // PATCH /api/repos/:id 相当(setRepoFlags)を経由しても保持されること
    const flagsResult = configModule.setRepoFlags(actualId, { pinned: true });
    expect(flagsResult.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8')).futureTopLevelFlag).toBe('kept');
  });

  it('parsed が null / 文字列 / 配列のときに spread で壊れず空 repos を返す', async () => {
    const configModule = await freshConfigModule();
    fs.mkdirSync(configDir, { recursive: true });

    fs.writeFileSync(configFile, 'null', 'utf8');
    expect(configModule.loadConfig()).toEqual({ repos: [] });

    fs.writeFileSync(configFile, '"just a string"', 'utf8');
    expect(configModule.loadConfig()).toEqual({ repos: [] });

    fs.writeFileSync(configFile, '[1,2,3]', 'utf8');
    expect(configModule.loadConfig()).toEqual({ repos: [] });
  });
});

describe('worktreeDefaultPath', () => {
  const repoPath = path.join('C:', 'Users', 'me', 'ghq', 'github.com', 'me', 'prontella');
  const parent = path.dirname(repoPath);

  it('nested は現行の ../<repo>.worktrees/<branch> を 1 文字も変えない', () => {
    expect(worktreeDefaultPath(repoPath, 'prontella', 'feature/abc-def', 'nested')).toBe(
      path.join(parent, 'prontella.worktrees', 'feature-abc-def'),
    );
    expect(worktreeDefaultPath(repoPath, 'prontella', 'main', 'nested')).toBe(
      path.join(parent, 'prontella.worktrees', 'main'),
    );
  });

  it('ghq は本体の兄弟 ../<repo>=<branch> に置く', () => {
    expect(worktreeDefaultPath(repoPath, 'prontella', 'feature/abc-def', 'ghq')).toBe(
      path.join(parent, 'prontella=feature-abc-def'),
    );
    expect(worktreeDefaultPath(repoPath, 'prontella', 'main', 'ghq')).toBe(
      path.join(parent, 'prontella=main'),
    );
  });

  // ghq 配置でブランチ名の区切り文字が残ると、ディレクトリーが階層化して「本体の兄弟」で
  // なくなる。両レイアウトで等しく潰れることを固定する。
  it('ディレクトリー名に使えない文字はどちらのレイアウトでも - に潰れる', () => {
    const branch = 'a\\b/c:d*e?f"g<h>i|j';
    const flat = 'a-b-c-d-e-f-g-h-i-j';
    expect(worktreeDefaultPath(repoPath, 'prontella', branch, 'ghq')).toBe(
      path.join(parent, `prontella=${flat}`),
    );
    expect(worktreeDefaultPath(repoPath, 'prontella', branch, 'nested')).toBe(
      path.join(parent, 'prontella.worktrees', flat),
    );
  });
});

describe('getWorktreeLayout / setWorktreeLayout (隔離 home, 実 config 非接触)', () => {
  let isolatedHome: string;
  let configDir: string;
  let configFile: string;
  let originalUserProfile: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'prontella-wt-layout-home-'));
    configDir = path.join(isolatedHome, '.prontella');
    configFile = path.join(configDir, 'config.json');
    originalUserProfile = process.env.USERPROFILE;
    originalHome = process.env.HOME;
    process.env.USERPROFILE = isolatedHome;
    process.env.HOME = isolatedHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(isolatedHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it('未設定なら nested (既定は現状維持)', async () => {
    const configModule = await import('./config.js');
    expect(configModule.getWorktreeLayout()).toBe('nested');
  });

  it('ghq を保存すると config.json に載り、読み戻せる', async () => {
    const configModule = await import('./config.js');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ repos: [], futureTopLevelFlag: 'kept' }), 'utf8');

    expect(configModule.setWorktreeLayout('ghq')).toEqual({ ok: true, layout: 'ghq' });
    const written = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    expect(written.worktreeLayout).toBe('ghq');
    expect(written.futureTopLevelFlag).toBe('kept'); // 他のトップレベルキーを落とさない
    expect(configModule.getWorktreeLayout()).toBe('ghq');
  });

  it('不正な値は 400 側に落ち、既存の設定を書き換えない', async () => {
    const configModule = await import('./config.js');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ repos: [], worktreeLayout: 'ghq' }), 'utf8');

    for (const bad of ['', 'GHQ', 'Nested', null, undefined, 0, {}, ['ghq']]) {
      const result = configModule.setWorktreeLayout(bad);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8')).worktreeLayout).toBe('ghq');
  });

  it('手で壊された値 (config.json 直編集) は nested に倒れる', async () => {
    const configModule = await import('./config.js');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ repos: [], worktreeLayout: 'GHQ' }), 'utf8');
    expect(configModule.getWorktreeLayout()).toBe('nested');
  });
});
