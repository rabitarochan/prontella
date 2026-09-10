import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { classifyHunkLine, HUNK_CONFLICT_MESSAGE, hunkStats } from '../diffHunk';
import { bumpGitEpoch } from '../gitEpoch';
import { useT } from '../i18n';
import { useDeck } from '../store';
import type { DiffHunk } from '../types';
import { useConfirm } from './ConfirmDialog';

/**
 * DiffPane 内に載せる、ハンク単位の stage / unstage / discard 操作帯。
 * scope='worktree' | 'staged' のときだけ DiffPane から描画される
 * (scope='commit' と untracked ファイルの合成 diff は呼び出し側で除外済み)。
 */
export default function DiffHunkStrip({
  dir,
  path,
  scope,
  disabled,
  disabledReason,
  onApplied,
  onHunkStateChanged,
  onReveal,
}: {
  dir: string;
  path: string;
  scope: 'worktree' | 'staged';
  /**
   * 全操作を止める (現状の用途: DiffPane 側に未保存の編集がある間)。
   * discard は作業ツリーのファイルを書き換えるので未保存の編集を破壊し、
   * stage/unstage も onApplied → loadPair でエディターの内容を差し替えてしまう。
   * 「黙って壊す」より止める方を選ぶ (不可逆操作は申告と実際を一致させる)。
   */
  disabled?: boolean;
  /** disabled の理由。帯に出す。 */
  disabledReason?: string;
  /** stage/unstage/discard 適用後、diff 本体 (DiffPane 側の pair) を取り直させる */
  onApplied: () => void;
  /**
   * git の実状態が実際に変わった (= 409 ではなく適用成功した) ときだけ呼ばれる。
   * 同じファイルを別スコープ (staged/worktree) で開いている兄弟タブへ、
   * 再読込が必要なことを知らせるために使う (省略可)。
   */
  onHunkStateChanged?: () => void;
  /** ハンク行クリック時、Monaco 側をその位置へスクロールさせる (省略可) */
  onReveal?: (hunk: DiffHunk) => void;
}) {
  const t = useT();
  const refreshDeck = useDeck((s) => s.refresh);
  const { confirm: confirmDialog, dialog } = useConfirm();
  const [hunks, setHunks] = useState<DiffHunk[] | null>(null);
  // hunks と同順・同長。楽観ロック用ハッシュ(不具合2/3の修正)。POST /api/git/apply-hunks
  // の expectedHunkHashes にそのまま echo する。
  const [hunkHashes, setHunkHashes] = useState<string[]>([]);
  const [inFlight, setBusy] = useState(false);
  // 既存の全 disabled 条件が busy を見ているので、外からの停止もここに畳み込む。
  // 個々のボタンに条件を足して回ると、必ずどれかを取りこぼす。
  const busy = inFlight || !!disabled;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // 行単位選択 UI: 一度に展開できるのは 1 ハンクだけ (アコーディオン)。selectedLines は
  // expandedIndex が指すハンクの hunk.lines への添字集合で、別ハンクの行を混ぜて選ばせない。
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [selectedLines, setSelectedLines] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    try {
      const result = await api.diffHunks(dir, path, scope);
      setHunks(result.hunks);
      setHunkHashes(result.hunkHashes);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      // ハンク一覧を取り直すたびに行選択をリセットする。適用成功・409 再読込のどちらでも
      // ハンクの中身/添字がずれ得るため、古い選択を残すと次の操作が別の行に当たってしまう
      // (2.4a からの申し送り)。初回マウント時のリセットは無害。
      setExpandedIndex(null);
      setSelectedLines(new Set());
    }
  }, [dir, path, scope]);

  useEffect(() => {
    setHunks(null);
    setError('');
    setNotice('');
    void load();
  }, [load]);

  const runApply = async (index: number, applyScope: 'stage' | 'unstage' | 'discard', lines?: number[]) => {
    if (!hunks || busy) return;
    setBusy(true);
    setNotice('');
    try {
      await api.applyHunks(
        dir,
        path,
        applyScope,
        [index],
        hunks.length,
        // 自分が見ているそのハンクのハッシュをそのまま送る。サーバー側が権威 diff から
        // 同じ関数で再計算して突き合わせる(不具合2/3の修正。行選択の有無にかかわらず
        // 無条件で照合されるため、ハンク単位操作でも外部編集による並行変更を検出できる)。
        [hunkHashes[index]],
        lines && [lines],
      );
      await load(); // load() が行選択もリセットする
      onApplied();
      onHunkStateChanged?.();
      void refreshDeck();
      // index (と discard なら作業ツリー) が変わったので、ファイルパネルのガター差分に知らせる。
      bumpGitEpoch(dir);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === HUNK_CONFLICT_MESSAGE) {
        // 409: 操作は適用されていない。差分とハンク一覧を取り直すだけで、破棄確認等はやり直させる。
        setNotice(t('hunk.reloadedNotice'));
        await load();
        onApplied();
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  const apply = (index: number, applyScope: 'stage' | 'unstage' | 'discard') => runApply(index, applyScope);

  const discard = async (index: number, hunk: DiffHunk) => {
    const ok = await confirmDialog({
      title: t('hunk.discardTitle'),
      message: t('hunk.discardMessage', { header: hunk.header }),
      confirmLabel: t('git.discard'),
      severity: 'danger',
    });
    if (!ok) return;
    void apply(index, 'discard');
  };

  // 行単位ステージ用。selectedLines が空のときは呼び出し元 (ボタンの disabled 条件) が
  // 防いでいるはずだが、ここでも二重に防御する (サーバー側は空/コンテキストのみの選択を
  // 400 ではなく 500 で返すため — 2.4a からの申し送り。UI から到達させない)。
  const applyLines = (index: number, applyScope: 'stage' | 'unstage' | 'discard') => {
    if (selectedLines.size === 0) return Promise.resolve();
    return runApply(index, applyScope, Array.from(selectedLines).sort((a, b) => a - b));
  };

  const discardLines = async (index: number, hunk: DiffHunk) => {
    if (selectedLines.size === 0) return;
    // 保守的な過剰近似(reviewer 方針・(b)): サーバー側のペアリング/marker 引き込みロジックを
    // クライアントに複製すると非対称バグの温床になるため(このプロジェクトの過去の教訓)、
    // 厳密な事前計算はしない。ハンクに EOF marker (`\` 始まりの行) があり、かつ選択が
    // そのハンクの add/del 行すべてを覆っていない場合だけ、「関連する行も一緒に戻り得る」
    // という警告を追加する。実際には拡大しない場合にも出る過剰警告になり得るが、discard は
    // 不可逆操作なので安全側に倒す。stage/unstage は対象外(可逆・load() で結果が即座に
    // 画面に反映され目視できるため、pj-git-route の「影響件数は正確に」はここでは discard
    // だけが対象という reviewer 判定)。
    const hasEofMarker = hunk.lines.some((l) => l.startsWith('\\'));
    const changeLineCount = hunk.lines.filter((l) => l.startsWith('+') || l.startsWith('-')).length;
    const coversAllChangeLines = selectedLines.size >= changeLineCount;
    const expansionWarning = hasEofMarker && !coversAllChangeLines ? t('hunk.eofWarning') : '';
    const ok = await confirmDialog({
      title: t('hunk.discardLinesTitle'),
      message: t('hunk.discardLinesMessage', {
        n: selectedLines.size,
        header: hunk.header,
        warning: expansionWarning,
      }),
      confirmLabel: t('git.discard'),
      severity: 'danger',
    });
    if (!ok) return;
    void applyLines(index, 'discard');
  };

  const toggleExpand = (index: number) => {
    // 別ハンクを開き直すときは選択も必ずクリアする (ハンクをまたいだ選択の混在を防ぐ)。
    setExpandedIndex((prev) => (prev === index ? null : index));
    setSelectedLines(new Set());
  };

  const toggleLine = (lineIndex: number) => {
    setSelectedLines((prev) => {
      const next = new Set(prev);
      if (next.has(lineIndex)) next.delete(lineIndex);
      else next.add(lineIndex);
      return next;
    });
  };

  if (error) {
    return (
      <div className="hunk-strip">
        <div className="hunk-strip-notice hunk-strip-error">⚠ {error}</div>
        {dialog}
      </div>
    );
  }
  // 読み込み中や差分なし (0 ハンク) は帯そのものを出さない。
  if (!hunks || hunks.length === 0) return null;

  return (
    <div className={`hunk-strip${expandedIndex !== null ? ' expanded' : ''}`}>
      {disabled && disabledReason && (
        <div className="hunk-strip-notice">⚠ {disabledReason}</div>
      )}
      {notice && <div className="hunk-strip-notice">{notice}</div>}
      <div className="hunk-strip-list">
        {hunks.map((hunk, index) => {
          const { added, removed } = hunkStats(hunk);
          const isExpanded = expandedIndex === index;
          return (
            <div key={index} className="hunk-chip-group">
              <div className="hunk-chip">
                <button
                  className="icon-btn hunk-chip-toggle"
                  disabled={busy}
                  title={isExpanded ? t('hunk.collapseLinesTooltip') : t('hunk.selectLinesTooltip')}
                  onClick={() => toggleExpand(index)}
                >
                  <span className={`codicon codicon-chevron-right hunk-chip-chevron${isExpanded ? ' open' : ''}`} />
                </button>
                <button
                  className="hunk-chip-loc"
                  title={t('git.scrollToTooltip')}
                  onClick={() => onReveal?.(hunk)}
                >
                  {hunk.header}
                </button>
                <span className="hunk-chip-stat">
                  {added > 0 && <span className="hunk-add">+{added}</span>}
                  {removed > 0 && <span className="hunk-del">-{removed}</span>}
                </span>
                <span className="hunk-chip-actions">
                  {scope === 'worktree' && (
                    <>
                      <button
                        className="icon-btn"
                        disabled={busy}
                        title={t('hunk.stageTooltip')}
                        onClick={() => void apply(index, 'stage')}
                      >
                        <span className="codicon codicon-add" />
                      </button>
                      <button
                        className="icon-btn"
                        disabled={busy}
                        title={t('hunk.discardTooltip')}
                        onClick={() => void discard(index, hunk)}
                      >
                        <span className="codicon codicon-discard" />
                      </button>
                    </>
                  )}
                  {scope === 'staged' && (
                    <button
                      className="icon-btn"
                      disabled={busy}
                      title={t('hunk.unstageTooltip')}
                      onClick={() => void apply(index, 'unstage')}
                    >
                      <span className="codicon codicon-remove" />
                    </button>
                  )}
                </span>
              </div>
              {isExpanded && (
                <div className="hunk-chip-lines">
                  <div className="hunk-line-list">
                    {hunk.lines.map((line, lineIndex) => {
                      // 末尾番人は「値が空文字列」ではなく「選択元 hunks の実際の最後のハンクの
                      // 最後の要素という位置」で判定する(不具合5の修正。diff.suppressBlankEmpty
                      // の空行 context 行を誤って消さないため)。
                      const isSentinelPosition = index === hunks.length - 1 && lineIndex === hunk.lines.length - 1;
                      const kind = classifyHunkLine(line, isSentinelPosition);
                      if (kind === 'eof-sentinel') return null; // 末尾改行の番人。表示・選択対象外
                      const checkable = kind === 'add' || kind === 'del';
                      return (
                        <label key={lineIndex} className={`hunk-line-row hunk-line-${kind}`}>
                          {checkable ? (
                            <input
                              type="checkbox"
                              disabled={busy}
                              checked={selectedLines.has(lineIndex)}
                              onChange={() => toggleLine(lineIndex)}
                            />
                          ) : (
                            <span className="hunk-line-checkbox-spacer" />
                          )}
                          <span className="hunk-line-text">{line || ' '}</span>
                        </label>
                      );
                    })}
                  </div>
                  <div className="hunk-line-actions">
                    {scope === 'worktree' && (
                      <>
                        <button
                          disabled={busy || selectedLines.size === 0}
                          onClick={() => void applyLines(index, 'stage')}
                        >
                          {t('hunk.stageLinesButton')}
                        </button>
                        <button
                          className="danger"
                          disabled={busy || selectedLines.size === 0}
                          onClick={() => void discardLines(index, hunk)}
                        >
                          {t('hunk.discardLinesButton')}
                        </button>
                      </>
                    )}
                    {scope === 'staged' && (
                      <button
                        disabled={busy || selectedLines.size === 0}
                        onClick={() => void applyLines(index, 'unstage')}
                      >
                        {t('hunk.unstageLinesButton')}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {dialog}
    </div>
  );
}
