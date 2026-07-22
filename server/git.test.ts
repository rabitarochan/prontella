import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import {
  decodeBlameContent,
  parseBlamePorcelain,
  parseFollowLog,
  parseRemotesOutput,
  unquoteGitPath,
  type RawBlameLine,
} from './git.js';

const US = '\x1f';
/** getLog と同じ %H%x1f%h%x1f%P%x1f%an%x1f%cI%x1f%s%x1f%D 形式の 1 コミット分を組み立てる。 */
function prettyLine(fields: {
  hash: string;
  shortHash?: string;
  parents?: string;
  author?: string;
  date?: string;
  subject: string;
  refs?: string;
}): string {
  return [
    fields.hash,
    fields.shortHash ?? fields.hash.slice(0, 7),
    fields.parents ?? '',
    fields.author ?? 'Tester',
    fields.date ?? '2026-01-01T00:00:00+09:00',
    fields.subject,
    fields.refs ?? '',
  ].join(US);
}

describe('unquoteGitPath', () => {
  it('passes through a path that git did not quote', () => {
    expect(unquoteGitPath('src/index.ts')).toBe('src/index.ts');
  });

  it('decodes octal-escaped UTF-8 bytes into the original multibyte text', () => {
    expect(unquoteGitPath('"\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt"')).toBe('日本語.txt');
  });

  it('decodes escaped double quotes and backslashes', () => {
    expect(unquoteGitPath('"foo\\"bar\\\\baz"')).toBe('foo"bar\\baz');
  });
});

describe('parseRemotesOutput', () => {
  it('通常の remote (fetch/push が同一 URL) を 1 件にまとめる', () => {
    const out = ['origin\thttps://example.com/repo.git (fetch)', 'origin\thttps://example.com/repo.git (push)'].join(
      '\n',
    );
    expect(parseRemotesOutput(out)).toEqual([
      { name: 'origin', fetchUrl: 'https://example.com/repo.git', pushUrl: 'https://example.com/repo.git' },
    ]);
  });

  it('空白を含む Windows パス URL を取りこぼさない (旧 \\S+ 実装の回帰防止)', () => {
    const out = [
      'backup\tC:\\Users\\dev\\My Documents\\repo (fetch)',
      'backup\tC:\\Users\\dev\\My Documents\\repo (push)',
    ].join('\n');
    expect(parseRemotesOutput(out)).toEqual([
      { name: 'backup', fetchUrl: 'C:\\Users\\dev\\My Documents\\repo', pushUrl: 'C:\\Users\\dev\\My Documents\\repo' },
    ]);
  });

  it('fetch と push で異なる URL を別フィールドに割り当てる', () => {
    const out = [
      'origin\thttps://example.com/fetch-repo.git (fetch)',
      'origin\thttps://example.com/push-repo.git (push)',
    ].join('\n');
    expect(parseRemotesOutput(out)).toEqual([
      { name: 'origin', fetchUrl: 'https://example.com/fetch-repo.git', pushUrl: 'https://example.com/push-repo.git' },
    ]);
  });

  it('空行や remote 行以外の余計な行を無視する', () => {
    const out = [
      '',
      'origin\thttps://example.com/repo.git (fetch)',
      'not a remote line',
      'origin\thttps://example.com/repo.git (push)',
      '',
    ].join('\n');
    expect(parseRemotesOutput(out)).toEqual([
      { name: 'origin', fetchUrl: 'https://example.com/repo.git', pushUrl: 'https://example.com/repo.git' },
    ]);
  });

  it('複数 remote を name ごとに分けて返す', () => {
    const out = [
      'origin\thttps://example.com/repo.git (fetch)',
      'origin\thttps://example.com/repo.git (push)',
      'backup\thttps://backup.example.com/repo.git (fetch)',
      'backup\thttps://backup.example.com/repo.git (push)',
    ].join('\n');
    expect(parseRemotesOutput(out)).toEqual([
      { name: 'origin', fetchUrl: 'https://example.com/repo.git', pushUrl: 'https://example.com/repo.git' },
      { name: 'backup', fetchUrl: 'https://backup.example.com/repo.git', pushUrl: 'https://backup.example.com/repo.git' },
    ]);
  });
});

describe('parseFollowLog', () => {
  // `git log --follow --name-status --pretty=format:<US 区切り> -- <path>` の実出力
  // (隔離環境で 1 回リネームを挟んだフィクスチャに対して実測・突合済み)。
  it('リネームを 1 回挟んだ履歴で、各コミット時点の path/origPath を正しく割り当てる', () => {
    const out = [
      prettyLine({ hash: 'b1c396d0', parents: '335b2da7', subject: 'modify new.txt', refs: 'HEAD -> main' }) +
        '\nM\tnew.txt',
      prettyLine({ hash: '335b2da7', parents: 'e46902f4', subject: 'rename old.txt to new.txt' }) +
        '\nR100\told.txt\tnew.txt',
      prettyLine({ hash: 'e46902f4', parents: '4bd0893b', subject: 'modify old.txt' }) + '\nM\told.txt',
      prettyLine({ hash: '4bd0893b', parents: '', subject: 'add old.txt' }) + '\nA\told.txt',
    ].join('\n\n');

    const entries = parseFollowLog(out);

    expect(entries.map((e) => ({ hash: e.hash, subject: e.subject, path: e.path, origPath: e.origPath }))).toEqual([
      { hash: 'b1c396d0', subject: 'modify new.txt', path: 'new.txt', origPath: null },
      { hash: '335b2da7', subject: 'rename old.txt to new.txt', path: 'new.txt', origPath: 'old.txt' },
      { hash: 'e46902f4', subject: 'modify old.txt', path: 'old.txt', origPath: null },
      { hash: '4bd0893b', subject: 'add old.txt', path: 'old.txt', origPath: null },
    ]);
  });

  it('コピー (C) もリネーム同様 origPath に旧パスを設定する', () => {
    const out = prettyLine({ hash: 'aaa1111', parents: 'bbb2222', subject: 'copy config' }) + '\nC100\tbase.yml\tcopy.yml';
    expect(parseFollowLog(out)).toEqual([
      expect.objectContaining({ hash: 'aaa1111', path: 'copy.yml', origPath: 'base.yml' }),
    ]);
  });

  it('name-status 行が無いコミット (既定 no -m のマージコミット等) は除外する', () => {
    const out = [
      prettyLine({ hash: 'ccc3333', parents: 'ddd4444 eee5555', subject: 'Merge branch x' }), // name-status 行なし
      prettyLine({ hash: 'ddd4444', parents: 'fff6666', subject: 'normal commit' }) + '\nM\tfile.txt',
    ].join('\n\n');
    expect(parseFollowLog(out).map((e) => e.hash)).toEqual(['ddd4444']);
  });

  it('日本語ファイル名を core.quotepath=false 前提でそのまま通す (quote 無しのため unquoteGitPath は恒等)', () => {
    const out = prettyLine({ hash: 'fff7777', parents: '', subject: 'add japanese file' }) + '\nA\t日本語.txt';
    expect(parseFollowLog(out)).toEqual([expect.objectContaining({ path: '日本語.txt', origPath: null })]);
  });

  it('空文字列 (該当パスの履歴なし) は空配列を返す', () => {
    expect(parseFollowLog('')).toEqual([]);
  });
});

describe('parseBlamePorcelain', () => {
  // 以下のフィクスチャは全て、隔離環境で実 git (`git blame --porcelain`) を実行して観察した
  // 生出力をそのまま書き写したもの(実装を先に書いてから期待値を合わせたのではなく、実 git の
  // 出力を先に確認してからテストを書いた — 2.4 の教訓「期待値は実装の自己言及であってはならない」
  // に従う)。

  it('複数コミット・非連続な同一コミット再出現でメタデータが省略される場合も author/hash を正しく復元する', () => {
    // 実 git 観察: line1=Alice(初回コミット), line2=Bob(2 コミット目で変更+追記), line3=Alice
    // (line1 と非連続な別グループだが同じコミット — メタデータは省略される), line4=未コミット
    // (hash 全 0 の擬似コミット `Not Committed Yet`)。
    const text = [
      '5992c95113b8a55b980ea80791b18a96f2bd6d07 1 1 1',
      'author Alice',
      'author-mail <a@example.com>',
      'author-time 1784754784',
      'author-tz +0900',
      'committer Alice',
      'committer-mail <a@example.com>',
      'committer-time 1784754784',
      'committer-tz +0900',
      'summary first commit',
      'boundary',
      'filename f.txt',
      '\tline1',
      '0e67eec6f226627c5e7d9aa942af2437f1866cf2 2 2 1',
      'author Bob',
      'author-mail <b@example.com>',
      'author-time 1784754790',
      'author-tz +0900',
      'committer Bob',
      'committer-mail <b@example.com>',
      'committer-time 1784754790',
      'committer-tz +0900',
      'summary second commit: change line2, add line4',
      'previous 5992c95113b8a55b980ea80791b18a96f2bd6d07 f.txt',
      'filename f.txt',
      '\tline2-CHANGED',
      '5992c95113b8a55b980ea80791b18a96f2bd6d07 3 3 1', // Alice 再出現・メタデータ省略
      '\tline3',
      '0000000000000000000000000000000000000000 4 4 1',
      'author Not Committed Yet',
      'author-mail <not.committed.yet>',
      'author-time 1784754796',
      'author-tz +0900',
      'committer Not Committed Yet',
      'committer-mail <not.committed.yet>',
      'committer-time 1784754796',
      'committer-tz +0900',
      'summary Version of f.txt from f.txt',
      'previous 0e67eec6f226627c5e7d9aa942af2437f1866cf2 f.txt',
      'filename f.txt',
      '\tline4-uncommitted',
    ].join('\n') + '\n';

    const lines = parseBlamePorcelain(text);

    expect(lines).toEqual([
      {
        hash: '5992c95113b8a55b980ea80791b18a96f2bd6d07',
        author: 'Alice',
        authorTime: 1784754784,
        summary: 'first commit',
        path: 'f.txt',
        origLine: 1,
        line: 1,
        content: 'line1',
      },
      {
        hash: '0e67eec6f226627c5e7d9aa942af2437f1866cf2',
        author: 'Bob',
        authorTime: 1784754790,
        summary: 'second commit: change line2, add line4',
        path: 'f.txt',
        origLine: 2,
        line: 2,
        content: 'line2-CHANGED',
      },
      {
        // 非連続な再出現。メタデータ省略後も dedup キャッシュから正しく復元される。
        hash: '5992c95113b8a55b980ea80791b18a96f2bd6d07',
        author: 'Alice',
        authorTime: 1784754784,
        summary: 'first commit',
        path: 'f.txt',
        origLine: 3,
        line: 3,
        content: 'line3',
      },
      {
        hash: '0000000000000000000000000000000000000000',
        author: 'Not Committed Yet',
        authorTime: 1784754796,
        summary: 'Version of f.txt from f.txt',
        path: 'f.txt',
        origLine: 4,
        line: 4,
        content: 'line4-uncommitted',
      },
    ]);
  });

  it('末尾改行なし・空行を含むファイルで行内容を正しく分離する', () => {
    // 実 git 観察: 3 行連続の同一コミット(グループサイズ 3)。2・3 行目はヘッダーの
    // 数値フィールドが 2 個のみ(グループサイズ省略)。空行は `\t` 直後に何も続かない。
    // ファイル自体は末尾改行なしだが、blame 自身の出力は内容行も含め常に `\n` 終端になる。
    const text = [
      '4e93b42304db834f201acddc113b84fe0f820808 1 1 3',
      'author Alice',
      'author-mail <a@example.com>',
      'author-time 1784754826',
      'author-tz +0900',
      'committer Alice',
      'committer-mail <a@example.com>',
      'committer-time 1784754826',
      'committer-tz +0900',
      'summary add f2 with blank line and no eol',
      'filename f2.txt',
      '\tline1',
      '4e93b42304db834f201acddc113b84fe0f820808 2 2',
      '\t',
      '4e93b42304db834f201acddc113b84fe0f820808 3 3',
      '\tline3-no-eol',
    ].join('\n') + '\n';

    const lines = parseBlamePorcelain(text);

    expect(lines.map((l) => l.content)).toEqual(['line1', '', 'line3-no-eol']);
    expect(lines.every((l) => l.hash === '4e93b42304db834f201acddc113b84fe0f820808')).toBe(true);
    expect(lines.map((l) => l.line)).toEqual([1, 2, 3]);
  });

  it('リネームを跨いだ行で、コミットごとの当時のファイルパス (filename) を保持する', () => {
    // 実 git 観察 (git mv old.txt new.txt を挟んだ 3 コミット): line1/3 は rename 前の
    // old.txt 時点のコミット (filename: old.txt)、line2/4 は rename 後の new.txt 時点の
    // コミット (filename: new.txt, previous も new.txt — rename 自体は 1 つ前のコミットで
        // 既に完了しているため)。
    const text = [
      '56131752e70926d3d3aef473f38460bdf8ae1632 1 1 1',
      'author Alice',
      'author-mail <a@example.com>',
      'author-time 1784754887',
      'author-tz +0900',
      'committer Alice',
      'committer-mail <a@example.com>',
      'committer-time 1784754887',
      'committer-tz +0900',
      'summary c1 add old.txt',
      'boundary',
      'filename old.txt',
      '\tr1',
      'c7f4d5dac2319abfd68a8498050eac712be5e74d 2 2 1',
      'author Bob',
      'author-mail <b@example.com>',
      'author-time 1784754888',
      'author-tz +0900',
      'committer Bob',
      'committer-mail <b@example.com>',
      'committer-time 1784754888',
      'committer-tz +0900',
      'summary c3 modify after rename',
      'previous 9b97c690643cb6d0a216e44230961389c766e1b9 new.txt',
      'filename new.txt',
      '\tr2-mod',
      '56131752e70926d3d3aef473f38460bdf8ae1632 3 3 1',
      '\tr3',
      'c7f4d5dac2319abfd68a8498050eac712be5e74d 4 4 1',
      '\tr4',
    ].join('\n') + '\n';

    const lines = parseBlamePorcelain(text);

    expect(lines.map((l) => ({ hash: l.hash, path: l.path, content: l.content }))).toEqual([
      { hash: '56131752e70926d3d3aef473f38460bdf8ae1632', path: 'old.txt', content: 'r1' },
      { hash: 'c7f4d5dac2319abfd68a8498050eac712be5e74d', path: 'new.txt', content: 'r2-mod' },
      { hash: '56131752e70926d3d3aef473f38460bdf8ae1632', path: 'old.txt', content: 'r3' },
      { hash: 'c7f4d5dac2319abfd68a8498050eac712be5e74d', path: 'new.txt', content: 'r4' },
    ]);
  });

  it('空文字列 (0 バイトファイル) は空配列を返す', () => {
    expect(parseBlamePorcelain('')).toEqual([]);
  });
});

describe('decodeBlameContent', () => {
  const HASH = 'a'.repeat(40);

  /**
   * `git blame --porcelain` の生バイト列を latin1 文字列として組み立てるテスト用ヘルパー。
   * メタデータ(author 名・summary 等)は常に UTF-8、内容行 (contentBytes) は任意のバイト列
   * (Shift_JIS 等) を渡せる — 実 git が「メタデータは UTF-8 再エンコード、内容行はファイルの
   * 生バイトそのまま」で出力することを実測確認済み(git.ts の parseBlamePorcelain コメント参照)。
   */
  function porcelainLatin1(opts: {
    author: string;
    summary: string;
    fileName: string;
    contentLines: Buffer[]; // 各行の内容(生バイト、'\n' は含まない)
  }): string {
    const meta = Buffer.from(
      [
        `author ${opts.author}`,
        'author-mail <a@example.com>',
        'author-time 1000000000',
        'author-tz +0900',
        `committer ${opts.author}`,
        'committer-mail <a@example.com>',
        'committer-time 1000000000',
        'committer-tz +0900',
        `summary ${opts.summary}`,
        'boundary',
        `filename ${opts.fileName}`,
        '',
      ].join('\n'),
      'utf8',
    );
    const parts: Buffer[] = [];
    opts.contentLines.forEach((contentBuf, idx) => {
      const n = idx + 1;
      const header = Buffer.from(
        `${HASH} ${n} ${n}${idx === 0 ? ` ${opts.contentLines.length}` : ''}\n`,
        'utf8',
      );
      parts.push(header);
      if (idx === 0) parts.push(meta);
      parts.push(Buffer.from('\t', 'utf8'), contentBuf, Buffer.from('\n', 'utf8'));
    });
    return Buffer.concat(parts).toString('latin1');
  }

  it('UTF-8 日本語ファイルで author・summary・行内容が文字化けせずデコードされる', () => {
    const text = porcelainLatin1({
      author: '太郎',
      summary: '日本語コミット',
      fileName: 'jp.txt',
      contentLines: [Buffer.from('こんにちは', 'utf8'), Buffer.from('世界', 'utf8')],
    });
    const raw = parseBlamePorcelain(text);
    expect(raw[0]).toMatchObject({ author: '太郎', summary: '日本語コミット' });

    const result = decodeBlameContent(raw);

    expect(result.binary).toBe(false);
    expect(result.encoding).toBe('utf-8');
    expect(result.lines.map((l) => l.content)).toEqual(['こんにちは', '世界']);
  });

  it('Shift_JIS ファイルで行内容が文字化けせずデコードされる(メタデータは UTF-8 のまま)', () => {
    // jschardet は極端に短いサンプルだと Shift_JIS を誤検出する(実測済み。files.ts と共通の
    // 検出器のため、これはこの機能固有の欠陥ではなくアプリ横断の既知特性)。実利用に近い
    // 長さの文章を使い、検出confidenceを確保する。
    const line1 = 'これはテスト用の日本語のテキストです。文字コードの判定精度を確認するために十分な長さの文章を用意しています。';
    const line2 = '二行目もそれなりの長さの日本語文章にしておきます。これでエンコーディング判定の信頼度が上がるはずです。';
    const text = porcelainLatin1({
      author: '太郎',
      summary: 'add shift_jis file',
      fileName: 'sjis.txt',
      contentLines: [iconv.encode(line1, 'shift_jis'), iconv.encode(line2, 'shift_jis')],
    });
    const raw = parseBlamePorcelain(text);
    // メタデータは常に UTF-8 (git 自身の出力仕様) — Shift_JIS 化けの影響を受けない。
    expect(raw[0]).toMatchObject({ author: '太郎', summary: 'add shift_jis file' });

    const result = decodeBlameContent(raw);

    expect(result.binary).toBe(false);
    expect(result.encoding).toBe('shift_jis');
    expect(result.lines.map((l) => l.content)).toEqual([line1, line2]);
  });

  it('バイナリファイル (NUL を含む) は binary:true・lines 空を返す', () => {
    const text = porcelainLatin1({
      author: 'Alice',
      summary: 'add binary',
      fileName: 'bin.dat',
      contentLines: [Buffer.from([0x00, 0x01, 0x02, 0x03])],
    });
    const raw = parseBlamePorcelain(text);

    const result = decodeBlameContent(raw);

    expect(result).toEqual({ lines: [], encoding: null, binary: true, tooLarge: false, notFound: false });
  });

  it('空ファイル (rawLines 0 件) は utf-8 固定・binary:false・lines 空を返す', () => {
    expect(decodeBlameContent([])).toEqual({
      lines: [],
      encoding: 'utf-8',
      binary: false,
      tooLarge: false,
      notFound: false,
    });
  });

  it('MAX_FILE_SIZE を超えるファイルは tooLarge:true・lines 空を返す(6.5R R-3)', () => {
    // files.ts の readFileContent が tooLarge:true を返すのと同じ閾値(2MB)。エディターで
    // 開けないファイルを blame では丸ごと読めてしまう非対称を閉じる。
    const bigLine = 'x'.repeat(3 * 1024 * 1024); // 3MB > MAX_FILE_SIZE(2MB)
    const raw: RawBlameLine[] = [
      { hash: 'c'.repeat(40), origLine: 1, line: 1, content: bigLine, author: 'Alice', authorTime: 1, summary: 's', path: 'big.txt' },
    ];

    const result = decodeBlameContent(raw);

    expect(result).toEqual({ lines: [], encoding: null, binary: false, tooLarge: true, notFound: false });
  });

  it('1 行目が純 ASCII でも、ファイル全体からエンコーディングを検出する(6.5R T-1: 1行目だけを見る変異を殺す)', () => {
    // 1 行目だけを見て検出する実装(変異)だと、1 行目が ASCII のため utf-8 と誤判定され、
    // 2 行目以降の Shift_JIS バイトがそのまま utf-8 デコードされて文字化けする。
    const line1 = 'start';
    const line2 = 'これはテスト用の日本語のテキストです。文字コードの判定精度を確認するために十分な長さの文章を用意しています。';
    const line3 = '二行目もそれなりの長さの日本語文章にしておきます。これでエンコーディング判定の信頼度が上がるはずです。';
    const text = porcelainLatin1({
      author: 'Alice',
      summary: 'ascii first line then shift_jis',
      fileName: 'mixed.txt',
      contentLines: [Buffer.from(line1, 'utf8'), iconv.encode(line2, 'shift_jis'), iconv.encode(line3, 'shift_jis')],
    });
    const raw = parseBlamePorcelain(text);

    const result = decodeBlameContent(raw);

    expect(result.encoding).toBe('shift_jis');
    expect(result.lines.map((l) => l.content)).toEqual([line1, line2, line3]);
  });

  it('BOM 付き UTF-8 ファイルは 1 行目の内容から BOM を除いてデコードする(6.5R T-1)', () => {
    // decodeBlameContent は BOM を自前で切り落とさず iconv-lite の decode() に委ねる(BOM 付き
    // バイト列を渡せば自動的に除去されることを実測確認済み — 手動の bomLen 計算は死んだ分岐
    // だったため撤去した。詳細は decodeBlameContent 本体のコメント参照)。
    const text = porcelainLatin1({
      author: 'Alice',
      summary: 'add bom file',
      fileName: 'bom.txt',
      contentLines: [
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('BOMline1', 'utf8')]),
        Buffer.from('BOMline2', 'utf8'),
      ],
    });
    const raw = parseBlamePorcelain(text);

    const result = decodeBlameContent(raw);

    expect(result.encoding).toBe('utf-8');
    // BOM バイトは content に残らない。BOM が残っていれば 1 行目の先頭に U+FEFF が混入し、
    // この等価比較が失敗する。
    expect(result.lines.map((l) => l.content)).toEqual(['BOMline1', 'BOMline2']);
  });

  /**
   * 実 git のバイト単位の行区切りを模して `git blame --porcelain` の porcelain グループを
   * 合成するテスト用ヘルパー(6.5R R-1)。`utf16le` エンコードしたテキストを実際に生の
   * `0x0A` バイトで区切ることで、UTF-16LE の改行(2 バイト `0A 00`)を跨いだときに
   * git 自身が報告する「行」の構造(2 行目以降が 1 バイトずれる/末尾に phantom 行が
   * 付く)を、実装をなぞらず独立に再現する。
   */
  function splitByRawNewlineByte(buf: Buffer): Buffer[] {
    const segments: Buffer[] = [];
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) {
        segments.push(buf.subarray(start, i));
        start = i + 1;
      }
    }
    segments.push(buf.subarray(start));
    return segments;
  }

  function utf16leRawLines(text: string, fileName: string): RawBlameLine[] {
    const bom = Buffer.from([0xff, 0xfe]);
    const body = Buffer.from(text, 'utf16le');
    const segments = splitByRawNewlineByte(body);
    segments[0] = Buffer.concat([bom, segments[0]]);
    const HASH = 'd'.repeat(40);
    return segments.map((seg, idx) => ({
      hash: HASH,
      origLine: idx + 1,
      line: idx + 1,
      content: seg.toString('latin1'),
      author: 'Alice',
      authorTime: 1000000000,
      summary: 'add utf16le file',
      path: fileName,
    }));
  }

  it('UTF-16LE ファイル(ASCII 相当の内容)は行区切りのズレを復元して文字化けせず表示できる(6.5R R-1)', () => {
    // 実 git 観察: この内容 (BOM 付き UTF-16LE, 4 行) で git blame --porcelain は 5 グループを
    // 報告する (末尾に改行由来の空の phantom 行が付く)。行ごと個別デコードだと 2 行目以降が
    // 1 バイトずつずれて文字化けするが、全体再構築 + 一括デコード + 再分割で正しく復元できる。
    const raw = utf16leRawLines('alpha\nbravo\ncharlie\ndelta\n', 'u16le.txt');
    expect(raw).toHaveLength(5); // 実 git の phantom 行を含む観察どおりの件数

    const result = decodeBlameContent(raw);

    expect(result.binary).toBe(false);
    expect(result.encoding).toBe('utf-16le');
    expect(result.lines.map((l) => l.content)).toEqual(['alpha', 'bravo', 'charlie', 'delta', '']);
  });

  it('UTF-16LE ファイルで非改行コードポイントの下位バイトが 0x0A と一致すると整合性検証に失敗し binary:true になる(6.5R R-1)', () => {
    // U+300A (『》の片割れ』) は UTF-16LE で下位バイトが 0x0A になるため、git 自身がこの
    // 文字の途中を改行と誤認し、実際の行数 (4 行 + phantom 1 行 = 5) より多い 6 グループを
    // 報告する(実 git で確認済み)。この場合は行の対応関係が失われているため復元を諦め、
    // 安全側で binary:true (表示できません) にする。
    const raw = utf16leRawLines('あいうえお\n《かぎかっこ》を含む行\nかきくけこ\nさしすせそ\n', 'u16le_jp.txt');
    expect(raw.length).toBeGreaterThan(5); // 真の行数(4 行 + phantom 1 行)より多い

    const result = decodeBlameContent(raw);

    expect(result.binary).toBe(true);
    expect(result.lines).toEqual([]);
  });
});

describe('parseBlamePorcelain (6.5R 追加修正: SHA-256 / origLine と line の乖離)', () => {
  it('64 桁ハッシュ (SHA-256 リポジトリー) を正しく解析する(6.5R R-2)', () => {
    // 実 git 観察: `git init --object-format=sha256` のリポジトリーでは blame のハッシュが
    // 64 桁になる。40 桁固定の旧実装ではこの行が全て「想定外の行」として無言棄却され、
    // 中身のあるファイルが空ファイルと区別できなくなっていた。
    const hash64 = '51810ff7b2052fcf1c9b56389b8201e9d8abc5bb2052bf7713e9d5a91fd390eb';
    expect(hash64).toHaveLength(64);
    const text = [
      `${hash64} 1 1 3`,
      'author Alice',
      'author-mail <a@example.com>',
      'author-time 1784759158',
      'author-tz +0900',
      'committer Alice',
      'committer-mail <a@example.com>',
      'committer-time 1784759158',
      'committer-tz +0900',
      'summary sha256 commit',
      'boundary',
      'filename s.txt',
      '\tp1',
      `${hash64} 2 2`,
      '\tp2',
      `${hash64} 3 3`,
      '\tp3',
    ].join('\n') + '\n';

    const lines = parseBlamePorcelain(text);

    expect(lines.map((l) => ({ hash: l.hash, content: l.content }))).toEqual([
      { hash: hash64, content: 'p1' },
      { hash: hash64, content: 'p2' },
      { hash: hash64, content: 'p3' },
    ]);
  });

  it('解析できない行があると「空/行欠落」を装わずエラーにする(6.5R R-2: !m の黙殺対策)', () => {
    // ハッシュが短すぎる(規約外)行を 1 件混入させる。旧実装はこれを無言で読み飛ばし、
    // 中身のあるファイルが空配列(=一見正常な空ファイル)を装ってしまっていた。
    const text = [
      'deadbeef 1 1 1', // 8 桁だけ (40 未満) — ホワイトリスト外
      'author Alice',
      'author-time 1000000000',
      'summary bogus',
      'filename bogus.txt',
      '\tsome content',
    ].join('\n') + '\n';

    expect(() => parseBlamePorcelain(text)).toThrow();
  });

  it('先頭に行を挿入した履歴で origLine (導入時の行番号) と line (現版での行番号) が乖離する', () => {
    // 実 git 観察: 3 行のファイルに後から先頭へ 4 行挿入すると、元の 1 行目 (x1) は
    // origLine=1 (Alice のコミット時点の行番号) のまま line=5 (現版での行番号) になる。
    const text = [
      '76a0a3b0f41e5f15966323d4ced2c54904cac9ca 1 1 4',
      'author Bob',
      'author-mail <b@example.com>',
      'author-time 1784759149',
      'author-tz +0900',
      'committer Bob',
      'committer-mail <b@example.com>',
      'committer-time 1784759149',
      'committer-tz +0900',
      'summary c2 insert 4 lines at top',
      'previous bdb05bd8bbf4f9a3af0c7f5835d68df705019112 m.txt',
      'filename m.txt',
      '\ty1',
      '76a0a3b0f41e5f15966323d4ced2c54904cac9ca 2 2',
      '\ty2',
      '76a0a3b0f41e5f15966323d4ced2c54904cac9ca 3 3',
      '\ty3',
      '76a0a3b0f41e5f15966323d4ced2c54904cac9ca 4 4',
      '\ty4',
      'bdb05bd8bbf4f9a3af0c7f5835d68df705019112 1 5 3',
      'author Alice',
      'author-mail <a@example.com>',
      'author-time 1784759149',
      'author-tz +0900',
      'committer Alice',
      'committer-mail <a@example.com>',
      'committer-time 1784759149',
      'committer-tz +0900',
      'summary c1 initial 3 lines',
      'boundary',
      'filename m.txt',
      '\tx1',
      'bdb05bd8bbf4f9a3af0c7f5835d68df705019112 2 6',
      '\tx2',
      'bdb05bd8bbf4f9a3af0c7f5835d68df705019112 3 7',
      '\tx3',
    ].join('\n') + '\n';

    const lines = parseBlamePorcelain(text);

    expect(lines.map((l) => ({ origLine: l.origLine, line: l.line, content: l.content }))).toEqual([
      { origLine: 1, line: 1, content: 'y1' },
      { origLine: 2, line: 2, content: 'y2' },
      { origLine: 3, line: 3, content: 'y3' },
      { origLine: 4, line: 4, content: 'y4' },
      { origLine: 1, line: 5, content: 'x1' }, // ← origLine と line が乖離する行
      { origLine: 2, line: 6, content: 'x2' },
      { origLine: 3, line: 7, content: 'x3' },
    ]);
    // 全フィクスチャで両者が同値だと、入れ替えても検出できない変異が残る(6.5R T-1 指摘)。
    expect(lines.some((l) => l.origLine !== l.line)).toBe(true);
  });
});
