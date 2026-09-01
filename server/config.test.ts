import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeJsonAtomic } from './config.js';

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
