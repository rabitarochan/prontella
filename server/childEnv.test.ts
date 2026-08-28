import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeWindowsEnv, parseEnvNul } from './childEnv.js';

// composeWindowsEnv / parseEnvNul は副作用のない純関数なので、実際の PowerShell や
// ログインシェルを起動せずに合成規則だけを検証する。
// captureInheritedEnv/childEnv はモジュールスコープの状態を持つため、
// config.test.ts と同じく vi.resetModules() + 動的 import で毎回新しいインスタンスを得る。

describe('composeWindowsEnv', () => {
  const base = {
    session: {} as NodeJS.ProcessEnv,
    machine: {} as Record<string, string>,
    user: {} as Record<string, string>,
  };

  it('allowlist に載ったログオンセッション変数だけを引き継ぐ', () => {
    const out = composeWindowsEnv({
      ...base,
      session: {
        APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
        SystemRoot: 'C:\\WINDOWS',
        USERPROFILE: 'C:\\Users\\me',
        // 起動元シェルの汚染 — すべて落ちること
        NODE_ENV: 'production',
        PORT: '3711',
        NO_COLOR: '1',
        GIT_EDITOR: 'true',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
      },
    });
    expect(out.APPDATA).toBe('C:\\Users\\me\\AppData\\Roaming');
    expect(out.SystemRoot).toBe('C:\\WINDOWS');
    expect(out.USERPROFILE).toBe('C:\\Users\\me');
    expect(out).not.toHaveProperty('NODE_ENV');
    expect(out).not.toHaveProperty('PORT');
    expect(out).not.toHaveProperty('NO_COLOR');
    expect(out).not.toHaveProperty('GIT_EDITOR');
    expect(out).not.toHaveProperty('CLAUDECODE');
    expect(out).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
  });

  it('User が Machine に勝つ', () => {
    const out = composeWindowsEnv({
      ...base,
      machine: { TEMP: 'C:\\WINDOWS\\TEMP', JAVA_HOME: 'C:\\jdk-machine' },
      user: { TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp' },
    });
    expect(out.TEMP).toBe('C:\\Users\\me\\AppData\\Local\\Temp');
    expect(out.JAVA_HOME).toBe('C:\\jdk-machine');
  });

  it('PATH は Machine + User の連結になる', () => {
    const out = composeWindowsEnv({
      ...base,
      machine: { Path: 'C:\\WINDOWS;C:\\WINDOWS\\system32' },
      user: { Path: 'C:\\Users\\me\\Volta\\bin' },
    });
    expect(out.Path).toBe('C:\\WINDOWS;C:\\WINDOWS\\system32;C:\\Users\\me\\Volta\\bin');
    // 連結後のキーは 1 つだけ (PATH と Path が同居しない)
    expect(Object.keys(out).filter((k) => k.toUpperCase() === 'PATH')).toHaveLength(1);
  });

  it('PATH の末尾セミコロンを吸収し、片側が空でも壊れない', () => {
    expect(
      composeWindowsEnv({ ...base, machine: { Path: 'C:\\WINDOWS;' }, user: { Path: 'C:\\bin' } }).Path,
    ).toBe('C:\\WINDOWS;C:\\bin');
    expect(composeWindowsEnv({ ...base, machine: { Path: 'C:\\WINDOWS' }, user: {} }).Path).toBe('C:\\WINDOWS');
    expect(composeWindowsEnv({ ...base, machine: {}, user: { Path: 'C:\\bin' } }).Path).toBe('C:\\bin');
  });

  it('キー照合は大文字小文字を無視する (Windows の環境変数名は case-insensitive)', () => {
    const out = composeWindowsEnv({
      session: { Path: 'C:\\session-path', APPDATA: 'C:\\roaming' },
      machine: { PATH: 'C:\\WINDOWS' },
      user: { path: 'C:\\Users\\me\\bin' },
    });
    const pathKeys = Object.keys(out).filter((k) => k.toUpperCase() === 'PATH');
    expect(pathKeys).toHaveLength(1);
    expect(out[pathKeys[0]]).toBe('C:\\WINDOWS;C:\\Users\\me\\bin');

    // allowlist 判定も大文字小文字を無視する
    expect(composeWindowsEnv({ ...base, session: { appdata: 'C:\\roaming' } }).appdata).toBe('C:\\roaming');
  });
});

describe('parseEnvNul', () => {
  it('NUL 区切りの KEY=VALUE を解析する', () => {
    expect(parseEnvNul('HOME=/home/me\0SHELL=/bin/zsh\0')).toEqual({
      HOME: '/home/me',
      SHELL: '/bin/zsh',
    });
  });

  it('値に = や改行を含んでよい', () => {
    const out = parseEnvNul('A=x=y\0B=line1\nline2\0');
    expect(out.A).toBe('x=y');
    expect(out.B).toBe('line1\nline2');
  });

  it("'=' の無い要素や '=' で始まる要素は捨てる", () => {
    expect(parseEnvNul('BROKEN\0=novalue\0OK=1\0')).toEqual({ OK: '1' });
  });

  it('空の入力は空オブジェクトになる', () => {
    expect(parseEnvNul('')).toEqual({});
    expect(parseEnvNul(Buffer.alloc(0))).toEqual({});
  });
});

describe('captureInheritedEnv / childEnv', () => {
  afterEach(() => {
    vi.resetModules();
  });

  async function freshModule() {
    vi.resetModules();
    return import('./childEnv.js');
  }

  it('capture 時点の値を返し、その後の process.env 書き換えは混ざらない', async () => {
    const mod = await freshModule();
    mod.captureInheritedEnv({ FOO: 'captured' });
    // bin/claude-deck.js が capture 後に PORT/NODE_ENV を書く状況の再現
    const injected = 'DECK_TEST_INJECTED_AFTER_CAPTURE';
    process.env[injected] = 'leaked';
    try {
      const env = mod.childEnv();
      expect(env.FOO).toBe('captured');
      expect(env).not.toHaveProperty(injected);
    } finally {
      delete process.env[injected];
    }
  });

  it('extra をマージし、同名キーは extra が勝つ', async () => {
    const mod = await freshModule();
    mod.captureInheritedEnv({ FOO: 'base', GIT_TERMINAL_PROMPT: '1' });
    expect(mod.childEnv({ GIT_TERMINAL_PROMPT: '0' })).toEqual({
      FOO: 'base',
      GIT_TERMINAL_PROMPT: '0',
    });
  });

  it('未 capture では process.env にフォールバックする', async () => {
    const mod = await freshModule();
    const key = 'DECK_TEST_NO_CAPTURE';
    process.env[key] = 'from-process-env';
    try {
      expect(mod.childEnv()[key]).toBe('from-process-env');
    } finally {
      delete process.env[key];
    }
  });
});
