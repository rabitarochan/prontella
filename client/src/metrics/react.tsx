import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from 'react';
import { metrics } from './core';

/**
 * React の commit 数と actualDuration を集計する Profiler ラッパー。
 *
 * 本番ビルドの React では `<Profiler>` は no-op (プロファイリングビルドでのみ計測される) ので、
 * この信号は `vite dev` でだけ出る。dev 層でなければコールバックは何もしない。
 * 本番での「余計な再レンダー」の代理指標は store の set 回数・ポーリングの unchanged 比。
 */
const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  if (!metrics.enabled || !metrics.includeAttrs) return;
  metrics.count('react.commit');
  metrics.observe('react.commit', actualDuration);
};

export function MetricsProfiler({ children }: { children: ReactNode }) {
  return (
    <Profiler id="app" onRender={onRender}>
      {children}
    </Profiler>
  );
}
