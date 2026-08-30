import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import type { AgentSubagent } from '../types';

/**
 * 「いま何をしているか」のチップ列。ターミナル (hook 由来) と
 * chat (Agent SDK) の両方で使う共通表示。
 *
 * 見た目は chat の統計バー由来のクラス (.chat-subagents / .chat-sub*) をそのまま使い、
 * 2 経路で体験が割れないようにしてある。表示するものが無ければ null を返すので、
 * hook が届かないセッション (素のシェル・手動起動 claude) では今までどおり何も出ない。
 */
export default function AgentActivityStrip({
  tool,
  toolSince,
  subagents,
}: {
  /** リードが実行中のツールの要約 ("Bash: npm test")。 */
  tool?: string | null;
  toolSince?: number | null;
  subagents: AgentSubagent[];
}) {
  const t = useT();
  const hasElapsed = subagents.length > 0 || toolSince != null;
  const tick = useElapsedTick(hasElapsed);
  void tick; // 経過時間の再描画のためだけに購読している

  if (!tool && subagents.length === 0) return null;

  return (
    <span className="chat-subagents">
      {tool && (
        <span className="chat-sub" title={t('activity.toolTooltip')}>
          <span className="chat-sub-dot" />
          <span className="chat-sub-activity">{tool}</span>
          {toolSince != null && <span className="chat-sub-elapsed">{fmtElapsed(toolSince)}</span>}
        </span>
      )}
      {subagents.map((sub) => (
        <span
          key={sub.id}
          className="chat-sub"
          title={sub.description || t('activity.subagentTooltip', { name: sub.name })}
        >
          <span className={sub.state === 'idle' ? 'chat-sub-dot is-idle' : 'chat-sub-dot'} />
          <span className="chat-sub-name">{sub.name}</span>
          <span className="chat-sub-elapsed">{fmtElapsed(sub.startedAt)}</span>
          {sub.activity && <span className="chat-sub-activity">{sub.activity}</span>}
        </span>
      ))}
    </span>
  );
}

/** 経過時間の表示を 1 秒ごとに更新する。表示対象が無いときはタイマーを持たない。 */
function useElapsedTick(active: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return tick;
}

export function fmtElapsed(startedAt: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}
