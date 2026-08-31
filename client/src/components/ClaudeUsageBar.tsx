// Claude のプラン使用量のコンパクト表示。ターミナルタイルのヘッダー
// (tileBarSlots のメインゾーン) へ TermPanel がポータルする。
//
// 表示するのは server/usage.ts が SDK の型定義から拾った枠だけ:
// 5 時間枠 / 週枠 / モデル別週枠 (Fable 等)。データはアカウント全体で共通なので
// 取得は usageStore の参照カウント付き共有ポーリング (タイルが何枚でも HTTP 1 本)。
//
// 見た目の方針: 文字は常にテーマの前景色 (--fg) で、ヘッダーの中で色を持つのは
// ゲージだけ。通常時のゲージは中立色にしてあるので、注意 (黄) / 警告 (赤) が
// 出たときだけヘッダーに色が現れる = 目に留まる。リセットまでの残り時間は
// 常時表示すると桁が動いてうるさいので、ツールチップ側にだけ残す。

import { useT } from '../i18n';
import { useUsage, useUsageStore } from '../layout/usageStore';
import type { UsageWindow } from '../types';

/** 使用率がここを超えたら注意 (黄) / 警告 (赤) にする。 */
const WARN_PCT = 80;
const DANGER_PCT = 95;

/** `resetsAt` までの残りを "2h13m" / "5d10h" / "12m" で返す。過ぎていれば null。 */
export function formatRemaining(resetsAt: string | null, now: number): string | null {
  if (!resetsAt) return null;
  const ms = Date.parse(resetsAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes % 60}m`;
  return `${Math.max(1, minutes)}m`;
}

function level(pct: number): string {
  if (pct >= DANGER_PCT) return 'is-danger';
  if (pct >= WARN_PCT) return 'is-warn';
  return '';
}

function Slot({ label, window: w }: { label: string; window: UsageWindow | null }) {
  if (!w || w.utilization === null) return null;
  const pct = Math.round(w.utilization);
  return (
    <span className={`usage-slot ${level(pct)}`}>
      <span className="usage-slot-label">{label}</span>
      {/* ゲージは % の視覚的な言い換えなので、読み上げからは外す。
          0% は空のまま、1% 以上は最低 2px 出して「わずかに使っている」と
          「まったく使っていない」を見分けられるようにする */}
      <span className="usage-gauge" aria-hidden="true">
        <span
          className="usage-gauge-fill"
          style={{ width: pct <= 0 ? 0 : `max(2px, ${Math.min(100, pct)}%)` }}
        />
      </span>
      <span className="usage-slot-pct">{pct}%</span>
    </span>
  );
}

export default function ClaudeUsageBar() {
  const t = useT();
  const { usage, loading } = useUsage();
  const refresh = useUsageStore((s) => s.refresh);
  const now = Date.now();

  if (loading && usage === null) {
    return <span className="usage-bar is-loading">{t('usage.loading')}</span>;
  }
  // 取得不可 (API キー運用 / Bedrock / Vertex / SDK 未対応) は何も出さない
  if (!usage || !usage.available) return null;

  const slots = [
    { key: 'five', label: t('usage.fiveHour'), window: usage.fiveHour },
    { key: 'week', label: t('usage.weekly'), window: usage.sevenDay },
    ...usage.modelScoped.map((m) => ({
      key: `model:${m.displayName}`,
      label: m.displayName,
      window: m as UsageWindow,
    })),
  ].filter((s) => s.window && s.window.utilization !== null);

  if (slots.length === 0) return null;

  // 残り時間はここだけに出す (常時表示すると分単位で桁が動いてヘッダーが騒がしい)
  const tooltip = [
    ...slots.map((s) => {
      const remaining = formatRemaining(s.window!.resetsAt, now);
      return remaining
        ? t('usage.tooltipLineReset', {
            label: s.label,
            pct: String(Math.round(s.window!.utilization!)),
            remaining,
          })
        : t('usage.tooltipLine', {
            label: s.label,
            pct: String(Math.round(s.window!.utilization!)),
          });
    }),
    t('usage.tooltipUpdated', { time: new Date(usage.fetchedAt).toLocaleTimeString() }),
    t('usage.refreshHint'),
  ].join('\n');

  return (
    <button
      className="usage-bar"
      title={tooltip}
      onClick={() => void refresh()}
      aria-label={t('usage.refresh')}
    >
      {slots.map((s) => (
        <Slot key={s.key} label={s.label} window={s.window} />
      ))}
    </button>
  );
}
