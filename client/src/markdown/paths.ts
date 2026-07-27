/**
 * Markdown プレビュー内のリンク・画像パス解決とサニタイズ判定を行う純関数群。
 * DOM / fetch / Node の `path` モジュールには依存しない — ブラウザーでもテストでも
 * 同じロジックがそのまま動くことを優先する (conflictBlocks.ts / diffHunk.ts と同じ位置づけ)。
 */

export type LinkKind =
  | { kind: 'external'; url: string } // http: / https:
  | { kind: 'relative'; path: string } // root 配下に解決できた (root 相対、先頭スラッシュ無し)
  | { kind: 'anchor'; hash: string } // #foo
  | { kind: 'blocked' }; // javascript: / data: / vbscript: / file: / プロトコル相対 / 解決不能 / その他スキーム

/**
 * パーセントエンコードされた文字列を安全にデコードする。単独の % や壊れた
 * UTF-8 バイト列など不正なシーケンスでは decodeURIComponent が URIError を
 * 投げるため、その場合は元の文字列をそのまま返す (呼び出し元を throw させない)。
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** fromMdPath のディレクトリー部分 (root 相対、末尾スラッシュ無し)。ルート直下なら空文字。 */
function dirnameOf(mdPath: string): string {
  const idx = mdPath.lastIndexOf('/');
  return idx === -1 ? '' : mdPath.slice(0, idx);
}

/**
 * '\' を '/' に正規化する。
 *
 * 方針 (どちらでも良いとされた「'\' を正規化する / '\' を含む target を blocked にする」
 * のうち正規化を選んだ理由): このアプリは Windows を主対象にしており
 * (server/config.ts が os.homedir() を使い、実サーバーも Windows で動く)、
 * server/files.ts の safeResolve は Node の path.resolve に委譲している。
 * path.resolve は Windows では '\' も '/' もパス区切りとして扱う (path.sep === '\')。
 * クライアント側の classifyHref/resolveRelative が '\' をただの 1 文字として無視すると、
 * "root 配下に解決できた" という relative の不変条件が Windows 環境でのサーバー側の
 * 実際の解釈とズレ、'..\..\secret.png' のような入力が (見た目上は root 配下に見えても)
 * 実際には root 外を指す、という多層防御の 1 枚が抜けた状態になる。
 *
 * '\' を含む target を丸ごと blocked にする案も検討したが、そちらは POSIX 上で
 * 正当なファイル名 (例: "a\b.png"。POSIX では '\' はファイル名として使える) を一律
 * 開けなくしてしまう。一方 Windows は '\' をファイル名に使うこと自体ができない
 * (NTFS/FAT の予約文字) ため、Windows を主対象とする現状では「'\' を区切りとして
 * 正規化する」方が実害が無く、かつ既存の '/' 用の '..' 畳み込み・root 脱出判定
 * (下記 resolveRelative) をそのまま再利用できる分だけ安全性の検証コストも低い。
 * 正規化後は通常の '/' 区切りロジックに完全に乗るため、'..\..\' のような入力も
 * 既存の root 脱出判定 (stack が空で '..' に遭遇したら null) でそのまま弾かれる。
 */
function normalizeBackslashes(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * 文字列が空、または ASCII スペース (0x20) や C0 制御文字のみで構成されているか。
 * normalizeSchemeCandidate と同じ定義 (コードポイント <= 0x20) を使う。href.trim() は
 * 標準的な空白しか除去せず、単独の制御文字 (例: \x01) だけの入力はそのまま残るため、
 * こちらで別途判定する。
 */
function isBlank(value: string): boolean {
  for (const ch of value) {
    if ((ch.codePointAt(0) ?? 0) > 0x20) return false;
  }
  return true;
}

/**
 * デコード済み target が「ディレクトリーにしか解決しない」かどうか: '/' で区切った
 * 全セグメントが '' (空。連続する / や先頭・末尾の / によって生じる) か '.' か '..' の
 * いずれかのみで構成されている場合 (例: '', '.', './', '..', '../', '/', './../')。
 * この場合ファイル名やアンカーを一切含んでいないため、リンク・画像の参照先として
 * 意味を成さない (resolveRelative に通すと「現在のディレクトリー」を指す root 相対
 * パスに解決されてしまい、blocked にしたい対象が relative に誤分類される)。
 */
function isDirectoryOnlyTarget(decoded: string): boolean {
  return decoded.split('/').every((seg) => seg === '' || seg === '.' || seg === '..');
}

/**
 * fromMdPath (root 相対の .md パス、区切りは /) を基準に target を解決し、
 * root 相対パス (先頭スラッシュ無し、/ 区切り) へ正規化する。
 * - ./img/a.png / img/a.png → fromMdPath のディレクトリー基準
 * - 先頭 / (正規化後の '\' 由来も含む) → リポジトリールート相対 (GitHub 準拠。
 *   以降は同じロジックで正規化)
 * - . / .. セグメントは正規化し、../ (や正規化後の ..\) で root の外に出る場合は null
 *
 * デコード方針: この関数を target の唯一のデコードポイントとする
 * (呼び出し側の classifyHref にはデコード責務を持たせない)。markdown-it の
 * normalizeLink は encodeURI 相当のエンコードを行い / はエンコードしない
 * ため、"文字列全体を一度だけ decodeURIComponent してからパス区切りで split する"
 * 方針でエンコードされたパス区切り (%2F 等) によるセグメント偽装を心配せず
 * 安全にデコードできる。不正なパーセントシーケンスは safeDecode が握りつぶし、
 * デコード前の文字列のまま処理を続ける (throw しない)。fromMdPath はアプリ内部
 * で組み立てられる既にデコード済みの root 相対パスという前提のため、こちらは
 * デコードしない。
 *
 * '\' の扱い: デコード直後に normalizeBackslashes で '\' を '/' に正規化してから
 * セグメント分割する。Windows は path.resolve が '\' もパス区切りとして扱う
 * (server/files.ts の safeResolve が最終防衛線としてこれを踏まえて root 外判定を行う)
 * ため、クライアント側もここで合わせておかないと "root 配下に解決できた" という
 * 戻り値の不変条件が Windows 環境で崩れる (詳細は normalizeBackslashes のコメント)。
 */
export function resolveRelative(fromMdPath: string, target: string): string | null {
  const decoded = normalizeBackslashes(safeDecode(target));
  const isRootRelative = decoded.startsWith('/');
  const rawTarget = isRootRelative ? decoded.slice(1) : decoded;
  const baseDir = isRootRelative ? '' : dirnameOf(fromMdPath);

  const segments = [...(baseDir ? baseDir.split('/') : []), ...rawTarget.split('/')];

  const stack: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length === 0) return null; // root の外に出る
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  return stack.join('/');
}

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/;

/**
 * href からスキームを検出するための正規化。ブラウザーが URL のスキームを判定する際に
 * ASCII スペースやタブ・改行などの C0 制御文字を無視する挙動を模し、タブや制御文字を
 * 混ぜた難読化スキーム (例: "java" + タブ + "script:") を素通りさせないようにする。
 * scheme 判定のためだけに使い、実際に使う href の値 (external の url や relative の
 * path) には使わない。呼び出し側で「生の文字列」と「パーセントデコード後の文字列」の
 * 両方に適用し、二層防御にする (下記 classifyHref 参照)。
 */
function normalizeSchemeCandidate(href: string): string {
  let stripped = '';
  for (const ch of href) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20) continue; // ASCII スペース (0x20) と C0 制御文字 (タブ/改行/CR 含む) を除去
    stripped += ch;
  }
  return stripped.toLowerCase();
}

const MAX_DECODE_ITERATIONS = 8;

/**
 * value を decodeURIComponent で繰り返しデコードし、直前の結果と一致する (それ以上
 * 変化しない) まで進める。多重エンコード (例: "%2509" → 1 回目のデコードで "%09" ←
 * まだ難読化されたタブが残っている → 2 回目のデコードで実際のタブに変わる) が
 * 1 回のデコードでは解けないことに対応する。
 *
 * decodeURIComponent は正しい %XY シーケンスを 1 文字に潰す (3 文字 → 1 文字) ため、
 * 変化があった呼び出しは必ず文字列を短くする。よって「変化しなくなる」までの反復回数は
 * 入力長に比例して有限であり、原理上は無限ループしない。ただし敵対的な入力 (深くネスト
 * したエンコードの繰り返し) による計算量の悪化を避けるため上限回数で打ち切る。
 * 上限に達してもまだ変化し続けている場合は「収束しなかった」ことを settled:false で
 * 呼び出し元に伝える — 通常のファイル名では起こり得ない異常な入力なので、呼び出し側は
 * これを blocked に倒す。
 */
function decodeUntilStable(value: string): { text: string; settled: boolean } {
  let current = value;
  for (let i = 0; i < MAX_DECODE_ITERATIONS; i++) {
    const next = safeDecode(current);
    if (next === current) {
      return { text: current, settled: true };
    }
    current = next;
  }
  return { text: current, settled: false };
}

/** normalizeSchemeCandidate 適用後の文字列からスキームを取り出す。無ければ null。 */
function schemeOf(candidate: string): string | null {
  const match = SCHEME_RE.exec(candidate);
  return match ? match[1] : null;
}

/**
 * Markdown 内の href を分類する。安全性判定は保守的に倒し、判定に迷うものは
 * blocked とする:
 * - http: / https: のみ external (スキーム判定は大文字小文字を無視)
 * - それ以外の既知スキーム (javascript: data: vbscript: file: mailto: ftp: 等) は blocked
 * - #... は anchor
 * - //host/... (プロトコル相対 URL) は root 相対の /... と紛らわしいため明示的に blocked
 * - 空文字列 / 空白・制御文字のみ / '.' '..' 等ディレクトリーにしか解決しないものは blocked
 *   (下記 isDirectoryOnlyTarget を参照。ファイル・アンカーとして意味を成さないため)
 * - 上記以外は相対パスとして resolveRelative にかけ、成功なら relative / 失敗なら blocked
 *
 * スキーム判定の二層防御 (生の文字列 + パーセントデコード後の文字列):
 * スキーム判定は「生の href」と「decodeUntilStable でパーセントデコードした href」の
 * 両方に対して行う。"%6Aavascript:alert(1)" のようにスキーム自体をパーセントエンコード
 * した入力は、生の文字列に対する判定 (normalizeSchemeCandidate は C0 制御文字と空白しか
 * 剥がさず、% はそのまま残る) をすり抜けて "relative" に誤分類されてしまう (実際に
 * 発生していたバグ: デコードは resolveRelative 内でしか行っておらず、判定より後段
 * だったため)。デコード後の文字列にも同じスキーム判定をかけることでここを塞ぐ。
 * 生の文字列側のチェックも残しているのは、逆に「デコードすると無害になるが生の文字列
 * だけ見ると危険に見える」ケースを保守的側に倒すため — どちらかが blocked と判定すれば
 * 即座に blocked にする (両方が false のときだけ次に進む)。
 *
 * 多重エンコード対策: decodeUntilStable は "%2509" (%25 → '%' に、続く "09" と合わせて
 * "%09" になり、もう 1 回デコードして初めてタブになる) のような多重エンコードを、
 * 変化が無くなるまで繰り返しデコードすることで解く。上限回数に達してもなお変化して
 * いる場合は異常な入力とみなし settled:false → blocked に倒す。
 *
 * blank / directory-only 判定 (isBlank / isDirectoryOnlyTarget) も decodeUntilStable の
 * 結果を使う (多重エンコードされた '..' 等が directory-only 判定をすり抜けないように)。
 * resolveRelative 自身のデコード回数・意味論は変えない (元々 1 回だけデコードする実装の
 * まま) — 判定はあくまで classifyHref 側で完結させる。
 *
 * 二層防御の意図 (render.ts と対になる設計、こちらは markdown-it との関係):
 * render.ts 側は markdown-it 既定の validateLink をそのまま使う (javascript:/vbscript:/
 * file:/非画像 data: を検知した href はトークン生成前に '' へ潰される)。このため
 * classifyHref はここで href='' を確実に blocked とする必要がある — さもないと
 * resolveRelative('') が「対象セグメントが空 = fromMdPath のディレクトリーだけが残る」
 * という仕様上、blocked にしたいリンクが relative (現在のディレクトリーを指す path) に
 * 誤分類されてしまう。markdown-it 側の検査が万一すり抜けても、この関数自身の scheme /
 * blank / directory-only 判定が blocked にする。
 */
export function classifyHref(fromMdPath: string, href: string): LinkKind {
  const trimmed = href.trim();

  if (trimmed.startsWith('#')) {
    return { kind: 'anchor', hash: trimmed.slice(1) };
  }

  // プロトコル相対 URL。先頭 / 1 つ (root 相対) と紛らわしいため scheme 判定より先に弾く。
  if (trimmed.startsWith('//')) {
    return { kind: 'blocked' };
  }

  // 層1: 生の文字列に対するスキーム判定 (制御文字・空白の埋め込みによる難読化に対応)。
  const rawScheme = schemeOf(normalizeSchemeCandidate(trimmed));
  if (rawScheme) {
    if (rawScheme === 'http' || rawScheme === 'https') {
      return { kind: 'external', url: trimmed };
    }
    return { kind: 'blocked' };
  }

  // 層2: パーセントデコード (多重エンコード込み) + バックスラッシュ正規化後の文字列に
  // 対する判定。以降の判定 (プロトコル相対 / スキーム / blank・directory-only) は
  // すべてこの正規化済みの `decoded` 一本を見る (R-5 で判明した「正規化前の値を見ている
  // 判定が 1 つだけ残っていた」という不整合を避けるため、正規化はここで 1 回だけ行い、
  // これより後のすべての判定が同じ正規化後の値を参照するようにする)。
  const { text: decodedRaw, settled } = decodeUntilStable(trimmed);
  if (!settled) {
    // 上限回数に達してもデコードで変化し続けた = 通常のファイル名では起こらない
    // 異常な入力。安全側に倒す。
    return { kind: 'blocked' };
  }
  const decoded = normalizeBackslashes(decodedRaw);

  // R-5: プロトコル相対 URL は生の文字列だけでなく、デコード + バックスラッシュ正規化後の
  // 文字列に対しても判定する。'%5C%5Chost%5Cshare%5Ca.png' (Windows の UNC パス
  // '\\host\share\a.png' のパーセントエンコード形) は生の文字列としては '//' で始まらない
  // ため上の生文字列チェックをすり抜けるが、デコード + normalizeBackslashes を経ると
  // '//host/share/a.png' になる — これは既に blocked にしているリテラルの
  // '//host/share/a.png' と表記が違うだけで意味は同じであり、書き方によって結論が
  // 変わってはならない。
  if (decoded.startsWith('//')) {
    return { kind: 'blocked' };
  }

  const decodedScheme = schemeOf(normalizeSchemeCandidate(decoded));
  if (decodedScheme) {
    if (decodedScheme === 'http' || decodedScheme === 'https') {
      return { kind: 'external', url: trimmed };
    }
    return { kind: 'blocked' };
  }

  // 相対パス候補。resolveRelative にかける前に「ファイル・アンカーとして意味を成さない
  // 入力」を弾く (空文字・空白/制御文字のみ・ディレクトリーにしか解決しないもの)。
  // decoded は既にバックスラッシュ正規化済みなので isDirectoryOnlyTarget にそのまま渡せる
  // (isBlank は制御文字判定のみなので '\'/'/' どちらの表記でも結果は変わらない)。
  if (isBlank(decoded) || isDirectoryOnlyTarget(decoded)) {
    return { kind: 'blocked' };
  }

  const resolved = resolveRelative(fromMdPath, trimmed);
  if (resolved === null) return { kind: 'blocked' };
  return { kind: 'relative', path: resolved };
}

/** .md / .markdown (大文字小文字区別無し) で終わるパスか。 */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}
