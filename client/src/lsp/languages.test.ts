import { describe, expect, it } from 'vitest';
import { languageIdFor, serverIdFor, serverIdForPath } from './languages';

describe('languages', () => {
  it('.cs は csharp サーバー、.tsx は typescriptreact → typescript サーバー', () => {
    expect(languageIdFor('src/Program.cs')).toBe('csharp');
    expect(serverIdFor('csharp')).toBe('csharp');
    expect(serverIdForPath('src/Program.cs')).toBe('csharp');
    expect(languageIdFor('src/App.tsx')).toBe('typescriptreact');
    expect(serverIdForPath('src/App.tsx')).toBe('typescript');
    expect(serverIdForPath('a.js')).toBe('typescript');
  });
  it('対象外は null (.csx / .cake / 拡張子無し)', () => {
    expect(serverIdForPath('a.py')).toBeNull();
    expect(serverIdForPath('script.csx')).toBeNull();
    expect(serverIdForPath('Makefile')).toBeNull();
  });
});
