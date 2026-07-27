import { describe, expect, it } from 'vitest';
import { classifyHref, isMarkdownPath, resolveRelative } from './paths';

describe('resolveRelative', () => {
  it('resolves a dot-relative path against the directory of fromMdPath', () => {
    expect(resolveRelative('docs/guide.md', './img/a.png')).toBe('docs/img/a.png');
  });

  it('resolves a bare relative path (no leading ./) the same as a dot-relative one', () => {
    expect(resolveRelative('docs/guide.md', 'img/a.png')).toBe('docs/img/a.png');
  });

  it('resolves ../ within the directory of fromMdPath when it stays inside root', () => {
    expect(resolveRelative('docs/guide.md', '../assets/a.png')).toBe('assets/a.png');
  });

  it('returns null when ../ would escape the repository root', () => {
    expect(resolveRelative('README.md', '../../../etc/passwd')).toBeNull();
  });

  it('treats a leading / as repository-root-relative (GitHub convention)', () => {
    expect(resolveRelative('docs/a/b.md', '/img/a.png')).toBe('img/a.png');
  });

  it('normalizes intermediate . and .. segments', () => {
    expect(resolveRelative('docs/a/b.md', './../c/./d.png')).toBe('docs/c/d.png');
  });

  // デコード方針: resolveRelative は target の唯一のデコードポイントであり、内部で
  // decodeURIComponent を試みる (成功すればデコード後の文字列で解決する)。呼び出し側
  // (classifyHref) にはデコード責務を持たせない。
  it('decodes percent-encoded characters in target internally (decode policy: resolveRelative decodes, not the caller)', () => {
    expect(resolveRelative('README.md', 'a%20b.png')).toBe('a b.png');
  });

  it('decodes percent-encoded non-ASCII (Japanese) file names without corrupting them', () => {
    expect(resolveRelative('docs/guide.md', '%E7%94%BB%E5%83%8F/%E5%9B%B31.png')).toBe('docs/画像/図1.png');
  });

  it('leaves already-decoded Japanese file names untouched (decodeURIComponent is a no-op on non-percent text)', () => {
    expect(resolveRelative('docs/guide.md', '画像/図1.png')).toBe('docs/画像/図1.png');
  });

  it('does not throw on a malformed percent-escape sequence, falling back to the raw text', () => {
    expect(() => resolveRelative('README.md', 'a%zzb.png')).not.toThrow();
    expect(resolveRelative('README.md', 'a%zzb.png')).toBe('a%zzb.png');
  });
});

describe('classifyHref', () => {
  it('classifies javascript: as blocked', () => {
    expect(classifyHref('README.md', 'javascript:alert(1)')).toEqual({ kind: 'blocked' });
  });

  it('classifies JavaScript: (mixed case) as blocked', () => {
    expect(classifyHref('README.md', 'JavaScript:alert(1)')).toEqual({ kind: 'blocked' });
  });

  it('classifies a scheme obfuscated with an embedded tab (java<TAB>script:) as blocked', () => {
    const href = 'java' + String.fromCharCode(9) + 'script:alert(1)';
    expect(classifyHref('README.md', href)).toEqual({ kind: 'blocked' });
  });

  it('classifies data: as blocked', () => {
    expect(classifyHref('README.md', 'data:text/html,<script>')).toEqual({ kind: 'blocked' });
  });

  it('classifies vbscript: as blocked', () => {
    expect(classifyHref('README.md', 'vbscript:msgbox(1)')).toEqual({ kind: 'blocked' });
  });

  it('classifies file: as blocked', () => {
    expect(classifyHref('README.md', 'file:///etc/passwd')).toEqual({ kind: 'blocked' });
  });

  it('classifies mailto: as blocked (conservative: only http/https are external)', () => {
    expect(classifyHref('README.md', 'mailto:test@example.com')).toEqual({ kind: 'blocked' });
  });

  it('classifies ftp: as blocked (conservative: only http/https are external)', () => {
    expect(classifyHref('README.md', 'ftp://example.com/x')).toEqual({ kind: 'blocked' });
  });

  it('classifies a protocol-relative URL (//host/...) as blocked, not external or relative', () => {
    expect(classifyHref('README.md', '//evil.com/x.png')).toEqual({ kind: 'blocked' });
  });

  it('classifies https: as external', () => {
    expect(classifyHref('README.md', 'https://example.com/a.png')).toEqual({
      kind: 'external',
      url: 'https://example.com/a.png',
    });
  });

  it('classifies http: as external', () => {
    expect(classifyHref('README.md', 'http://example.com/a.png')).toEqual({
      kind: 'external',
      url: 'http://example.com/a.png',
    });
  });

  it('classifies a #hash as anchor', () => {
    expect(classifyHref('README.md', '#section')).toEqual({ kind: 'anchor', hash: 'section' });
  });

  it('classifies a resolvable relative path as relative', () => {
    expect(classifyHref('docs/guide.md', './img/a.png')).toEqual({ kind: 'relative', path: 'docs/img/a.png' });
  });

  it('classifies a relative path that escapes root as blocked', () => {
    expect(classifyHref('README.md', '../../etc/passwd')).toEqual({ kind: 'blocked' });
  });

  // markdown-it 自身の validateLink は javascript:/vbscript:/file:/非画像 data: を検知
  // すると href を空文字 '' に潰してからトークンを作る。空文字を resolveRelative に渡すと
  // 「対象セグメントが全て捨てられ、fromMdPath のディレクトリーだけが残る」仕様のため、
  // 何もチェックしなければ blocked にしたいリンクが relative (現在のディレクトリーを指す
  // path) に誤分類されてしまう。ここではその誤分類が実際に起きないことを固定する。
  it.each(['', '   ', '.', './', '..', '../'])(
    'classifies %j (blank or directory-only) as blocked, not relative',
    (href) => {
      expect(classifyHref('docs/guide.md', href)).toEqual({ kind: 'blocked' });
    },
  );

  it('classifies "../" as blocked even from a root-level file (docs/guide.md → "../" would resolve to repo root)', () => {
    expect(classifyHref('README.md', '../')).toEqual({ kind: 'blocked' });
  });

  it('classifies a bare root-relative "/" as blocked (points at the repository root directory, not a file)', () => {
    expect(classifyHref('docs/guide.md', '/')).toEqual({ kind: 'blocked' });
  });

  it('classifies a control-character-only href (not caught by .trim()) as blocked', () => {
    // \x01 (SOH) は String.prototype.trim() では除去されない (標準の空白扱いではないため)。
    // isBlank はコードポイント <= 0x20 で判定するので、trim 後もこれを blank として拾う。
    expect(classifyHref('docs/guide.md', '\x01')).toEqual({ kind: 'blocked' });
  });

  it('still resolves a normal relative path with a real file name (regression guard for the directory-only check)', () => {
    expect(classifyHref('docs/guide.md', './other.md')).toEqual({ kind: 'relative', path: 'docs/other.md' });
    expect(classifyHref('docs/guide.md', '../assets/a.png')).toEqual({ kind: 'relative', path: 'assets/a.png' });
  });

  // 敵対的フィクスチャで見つかった欠陥: スキーム判定を生の文字列にしか適用しておらず、
  // パーセントデコードは resolveRelative 内でしか行われていなかったため、スキーム自体を
  // パーセントエンコードした入力 (例: "%6Aavascript:alert(1)" は decodeURIComponent で
  // "javascript:alert(1)" になる) が判定をすり抜けて relative に誤分類されていた。
  // ("%6A" の行が最も分かりやすい例: デコードすると javascript:alert(1) そのもの。)
  it.each([
    'java%09script:alert(1)', // タブをパーセントエンコード
    'java%0Ascript:alert(1)', // 改行をパーセントエンコード
    '%6Aavascript:alert(1)', // スキーム名の先頭 1 文字 (j) をパーセントエンコード
    'java%20script:alert(1)', // スペースをパーセントエンコード
    'JAVA%09SCRIPT:alert(1)', // 大文字 + パーセントエンコードの組み合わせ
  ])('classifies percent-encoded obfuscated javascript scheme %j as blocked (not relative)', (href) => {
    expect(classifyHref('docs/guide.md', href)).toEqual({ kind: 'blocked' });
  });

  it('classifies a double-percent-encoded scheme (%2509 -> %09 -> tab) as blocked', () => {
    // %25 は '%' 自身のパーセントエンコード。1 回のデコードでは "java%09script:..." までしか
    // 戻らず、もう 1 回デコードして初めてタブになる (多重エンコード)。decodeUntilStable が
    // 変化しなくなるまで繰り返しデコードすることでこれを解いて blocked にする。
    expect(classifyHref('docs/guide.md', 'java%2509script:alert(1)')).toEqual({ kind: 'blocked' });
  });

  it('accepts the conservative false positive: a decoded colon in a relative path is blocked (Windows cannot have ":" in file names anyway)', () => {
    expect(classifyHref('docs/guide.md', 'a%3Ab.png')).toEqual({ kind: 'blocked' });
  });

  it('regression: a%20b.png still resolves to relative "a b.png" (percent-encoded space in a real file name is not scheme obfuscation)', () => {
    expect(classifyHref('README.md', 'a%20b.png')).toEqual({ kind: 'relative', path: 'a b.png' });
  });

  it('regression: percent-encoded Japanese file names still resolve correctly', () => {
    expect(classifyHref('docs/guide.md', '%E7%94%BB%E5%83%8F/%E5%9B%B31.png')).toEqual({
      kind: 'relative',
      path: 'docs/画像/図1.png',
    });
  });

  it('regression: normal relative links and external https links are unaffected', () => {
    expect(classifyHref('docs/guide.md', './other.md')).toEqual({ kind: 'relative', path: 'docs/other.md' });
    expect(classifyHref('docs/guide.md', '../assets/a.png')).toEqual({ kind: 'relative', path: 'assets/a.png' });
    expect(classifyHref('README.md', 'https://example.com/')).toEqual({
      kind: 'external',
      url: 'https://example.com/',
    });
  });

  // R-4 (敵対的レビューで発見): resolveRelative が '/' でしかセグメントを分割しておらず、
  // '\' を単なる 1 文字として扱っていた。Windows では path.resolve が '\' もパス区切りと
  // して扱う (server/files.ts の safeResolve が最終防衛線としてこれに依存する) ため、
  // '..\..\secret.png' のような入力が「root 配下に解決できた」relative の不変条件を
  // 満たさないまま relative に分類されてしまっていた。
  //
  // 採った方針: '\' を含む target を丸ごと blocked にするのではなく、'\' を '/' に
  // 正規化してから既存の '/' 用ロジック (..の畳み込み・root 脱出判定) にそのまま乗せる。
  // 理由: このアプリは Windows を主対象にしており (server/config.ts の os.homedir()、
  // pj-isolated-verify も Windows 前提)、Windows では '\' はファイル名として使えない
  // (NTFS/FAT の予約文字) ため「'\' を含む target を一律 blocked にする」ことの実害は
  // 無い一方、そちらを選ぶと "docs\img\a.png" のような Windows ユーザーが自然に書きそうな
  // '\' 区切りの相対パスまで開けなくなってしまう。正規化を選べば、その正当な入力は
  // 引き続き relative として解決しつつ、'..\' による root 脱出は既存の (すでに検証済みの)
  // '../' 用ロジックがそのまま検出してくれる。
  describe('R-4: backslash as a path separator (Windows)', () => {
    it('classifies percent-encoded backslash traversal ..%5C..%5Csecret.png as blocked (root escape via \\)', () => {
      expect(classifyHref('docs/guide.md', '..%5C..%5Csecret.png')).toEqual({ kind: 'blocked' });
    });

    it('classifies raw (non-percent-encoded) backslash traversal ..\\..\\secret.png as blocked (root escape via \\)', () => {
      expect(classifyHref('docs/guide.md', '..\\..\\secret.png')).toEqual({ kind: 'blocked' });
    });

    it('policy=normalize: a \\-separated relative path docs\\img\\a.png resolves as relative "docs/img/a.png" (not blocked)', () => {
      expect(classifyHref('README.md', 'docs\\img\\a.png')).toEqual({ kind: 'relative', path: 'docs/img/a.png' });
    });

    it('policy=normalize: a mixed-separator path docs/img\\a.png also resolves as relative "docs/img/a.png"', () => {
      expect(classifyHref('README.md', 'docs/img\\a.png')).toEqual({ kind: 'relative', path: 'docs/img/a.png' });
    });

    it('regression: normal forward-slash relative paths, percent-encoded spaces, Japanese file names, and https external links are unaffected by the backslash fix', () => {
      expect(classifyHref('docs/guide.md', './other.md')).toEqual({ kind: 'relative', path: 'docs/other.md' });
      expect(classifyHref('docs/guide.md', '../assets/a.png')).toEqual({ kind: 'relative', path: 'assets/a.png' });
      expect(classifyHref('README.md', 'a%20b.png')).toEqual({ kind: 'relative', path: 'a b.png' });
      expect(classifyHref('docs/guide.md', '%E7%94%BB%E5%83%8F/%E5%9B%B31.png')).toEqual({
        kind: 'relative',
        path: 'docs/画像/図1.png',
      });
      expect(classifyHref('README.md', 'https://example.com/')).toEqual({
        kind: 'external',
        url: 'https://example.com/',
      });
    });
  });

  // R-5 (敵対的レビューで発見): '//' で始まるプロトコル相対 URL のブロックは生の文字列
  // (trimmed) にしか適用しておらず、デコード + normalizeBackslashes を経てから判定して
  // いなかった。'%5C%5Chost%5Cshare%5Ca.png' (Windows の UNC パス '\\host\share\a.png'
  // のパーセントエンコード形) は生の文字列としては '//' で始まらないためすり抜け、
  // decodeUntilStable + normalizeBackslashes を経て初めて '//host/share/a.png' になる —
  // これはリテラルの '//host/share/a.png' と表記が違うだけで意味は同じなのに、
  // 書き方によって結論 (blocked か relative か) が変わってしまっていた。
  describe('R-5: encoded UNC paths must not bypass the protocol-relative block', () => {
    it('classifies the percent-encoded UNC path %5C%5Chost%5Cshare%5Ca.png as blocked', () => {
      expect(classifyHref('docs/guide.md', '%5C%5Chost%5Cshare%5Ca.png')).toEqual({ kind: 'blocked' });
    });

    it('classifies the raw (non-percent-encoded) UNC path \\\\host\\share\\a.png as blocked', () => {
      expect(classifyHref('docs/guide.md', '\\\\host\\share\\a.png')).toEqual({ kind: 'blocked' });
    });

    it('classifies a lowercase-hex percent-encoded UNC path %5c%5chost%5cshare%5ca.png as blocked', () => {
      expect(classifyHref('docs/guide.md', '%5c%5chost%5cshare%5ca.png')).toEqual({ kind: 'blocked' });
    });

    it('regression: a literal protocol-relative URL //host/share/a.png is still blocked (pre-existing behavior)', () => {
      expect(classifyHref('docs/guide.md', '//host/share/a.png')).toEqual({ kind: 'blocked' });
    });

    it('classifies a mixed form /%5Chost/share (leading real slash + encoded backslash) as blocked', () => {
      expect(classifyHref('docs/guide.md', '/%5Chost/share')).toEqual({ kind: 'blocked' });
    });

    it('classifies a doubly-percent-encoded UNC path as blocked (decodeUntilStable resolves it across 2 decode passes)', () => {
      // %25 -> '%' なので、1 回目のデコードで %5C%5Chost%5Cshare%5Ca.png になり、
      // 2 回目のデコードで初めて \\host\share\a.png になる。
      expect(classifyHref('docs/guide.md', '%255C%255Chost%255Cshare%255Ca.png')).toEqual({ kind: 'blocked' });
    });

    it('regression: normal paths and links (including the R-4 backslash-normalize policy) are unaffected by the R-5 fix', () => {
      // fromMdPath='docs/guide.md' なので baseDir='docs'。'\' 正規化後 'docs/img/a.png' に
      // baseDir 'docs' が前置され 'docs/docs/img/a.png' になる (コーディネーターの
      // 期待値と一致することを固定)。
      expect(classifyHref('docs/guide.md', 'docs\\img\\a.png')).toEqual({
        kind: 'relative',
        path: 'docs/docs/img/a.png',
      });
      expect(classifyHref('docs/guide.md', './other.md')).toEqual({ kind: 'relative', path: 'docs/other.md' });
      expect(classifyHref('docs/guide.md', '../assets/a.png')).toEqual({ kind: 'relative', path: 'assets/a.png' });
      expect(classifyHref('README.md', 'a%20b.png')).toEqual({ kind: 'relative', path: 'a b.png' });
      expect(classifyHref('docs/guide.md', '%E7%94%BB%E5%83%8F/%E5%9B%B31.png')).toEqual({
        kind: 'relative',
        path: 'docs/画像/図1.png',
      });
      expect(classifyHref('README.md', 'https://example.com/')).toEqual({
        kind: 'external',
        url: 'https://example.com/',
      });
    });
  });
});

describe('isMarkdownPath', () => {
  it.each(['README.md', 'README.MD', 'guide.markdown'])('returns true for %s', (path) => {
    expect(isMarkdownPath(path)).toBe(true);
  });

  it.each(['README.mdx', 'notes.txt'])('returns false for %s', (path) => {
    expect(isMarkdownPath(path)).toBe(false);
  });
});
