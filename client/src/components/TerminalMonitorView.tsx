import { useCallback, useMemo, useState } from 'react';
import { resolveAndSelect, sessionLabel, useAgentEvents } from '../agentEvents';
import { api } from '../api';
import { useT } from '../i18n';
import { exitMonitor } from '../layout/mainMode';
import {
  MONITOR_LEAF_ID,
  MONITOR_TERM_ROOT,
  initialMonitorTermState,
  monitorGroupFor,
  orderMonitorSessions,
} from '../layout/terminalMonitor';
import type { TermGroupNode } from '../layout/termGroups';
import { useDeck } from '../store';
import type { TerminalSession } from '../types';
import TermPanel from './TermPanel';

/**
 * ターミナルモニター: 全リポジトリー / worktree の PTY セッションを 1 画面に集め、
 * worktree のターミナルパネルと同じ操作系 (グループ分割・リサイズ・タブ DnD) で
 * 眺め、y/n 等をその場で打てる main ビュー。
 *
 * 実体は TermPanel の再利用: 所有権の出所が「タイルの leaf.sessions」ではなく
 * 「サーバー上の全 PTY セッション」になるだけ。初回は worktree ごとに 1 グループ、
 * 以後に現れたセッションは同じ worktree のグループへ入る (monitorGroupFor)。
 * 終了したセッションはサーバーから消えるのでタブも消える (worktree ページのように
 * 「(終了)」タブは残さない — 全体を俯瞰する画面ではノイズになる)。
 *
 * PTY の winsize は 1 つなので、このページを表示している間は各ターミナルが
 * ここでの寸法で再描画される (「表示しているページがサイズを取る」。詳細は
 * XTermView のファイルコメント)。worktree を開けばそちらの寸法に戻る。
 */
export default function TerminalMonitorView() {
  const t = useT();
  const sessions = useAgentEvents((s) => s.sessions);
  // ラベルは cwd → 登録済み worktree の解決結果なので、repos の読み込みでも再計算する
  const repos = useDeck((s) => s.repos);
  const ordered = useMemo(
    () => orderMonitorSessions(Object.values(sessions), sessionLabel),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, repos],
  );
  const ptySessions = useMemo(() => ordered.map((e) => e.session), [ordered]);
  const ownedIds = useMemo(() => ptySessions.map((s) => s.id), [ptySessions]);
  const liveMap = useMemo(() => new Map(ptySessions.map((s) => [s.id, s])), [ptySessions]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = activeId ? liveMap.get(activeId) ?? null : null;

  // 初期構成はマウント時点のセッション集合から (TermPanel が永続化状態の無いときだけ使う)
  const orderedAtMount = useState(() => ordered)[0];
  const defaultState = useCallback(() => initialMonitorTermState(orderedAtMount), [orderedAtMount]);

  const preferGroupFor = useCallback(
    (id: string, root: TermGroupNode) => monitorGroupFor(id, root, liveMap),
    [liveMap],
  );

  // 新規作成は「+」を押したグループのアクティブなセッションと同じ worktree で
  // (空グループの案内ボタンなら、直前にフォーカスしていたセッション → 先頭のセッション)。
  // 作られたセッションはどのタイルにも所有されないが、その worktree を開いたときに
  // useTileLayout の adoptSessions が拾う。
  const create = useCallback(
    async (run: string | undefined, ctx: { activeSessionId: string | null }) => {
      const base =
        (ctx.activeSessionId ? liveMap.get(ctx.activeSessionId) : null) ?? active ?? ptySessions[0] ?? null;
      if (!base) return;
      await api.createTerminal(base.cwd, run);
    },
    [liveMap, active, ptySessions],
  );

  const labelOf = useCallback(
    (s: TerminalSession) => {
      const label = sessionLabel(s);
      return s.claudeDetected ? `✦ ${label}` : label;
    },
    // sessionLabel は repos を読むので、repos が変わったら関数も差し替える
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repos],
  );

  return (
    <div className="monitor-view">
      <div className="monitor-header">
        <span className="codicon codicon-multiple-windows" />
        <span className="monitor-header-title">{t('monitor.title')}</span>
        <span className="monitor-header-count">{t('monitor.count', { n: ordered.length })}</span>
        <span className="monitor-header-hint" title={t('monitor.sizeHint')}>
          <span className="codicon codicon-info" />
        </span>
        <span className="monitor-header-spacer" />
        <span className="vnc-view-actions">
          <button
            className="icon-btn"
            title={active ? `${t('monitor.openWorktree')} — ${sessionLabel(active)}` : t('monitor.openWorktree')}
            disabled={!active}
            onClick={() => active && void resolveAndSelect(active.cwd)}
          >
            <span className="codicon codicon-link-external" />
          </button>
          <button className="icon-btn" title={t('monitor.close')} onClick={exitMonitor}>
            <span className="codicon codicon-close" />
          </button>
        </span>
      </div>
      {ordered.length === 0 ? (
        <div className="placeholder">
          <h2>{t('monitor.title')}</h2>
          <p>{t('monitor.empty')}</p>
          <p>{t('monitor.emptyHint')}</p>
        </div>
      ) : (
        <div className="monitor-body">
          <TermPanel
            leafId={MONITOR_LEAF_ID}
            root={MONITOR_TERM_ROOT}
            sessions={ptySessions}
            ownedIds={ownedIds}
            activeId={activeId}
            visible
            onActivate={setActiveId}
            onCloseTab={async (id) => {
              await api.killTerminal(id);
            }}
            create={create}
            defaultState={defaultState}
            labelOf={labelOf}
            preferGroupFor={preferGroupFor}
            webglPolicy="activeGroup"
          />
        </div>
      )}
    </div>
  );
}
