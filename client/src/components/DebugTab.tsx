import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { AdapterId } from '../debug/session';
import { useDebugStore, type Frame, type RunState, type StartChoice, type Variable } from '../debug/store';
import { useT, type StringKey } from '../i18n';
import { getFilesTabs } from '../search/registry';

/**
 * デバッグビュー (タイルの 1 ビュー)。ツールバー / コールスタック / 変数 / コンソール。
 * 状態とロジックは client/src/debug/store.ts。ここは描画とイベントの配線だけ (.tsx はテスト対象外)。
 * エディター側の装飾 (BP グリフ・現在行) は client/src/debug/decorations.ts がモデルに直接張る。
 */

interface ConfigsInfo {
  configs: Array<{ name: string; type: string; request: 'launch' | 'attach' }>;
  warnings: string[];
  defaultAvailable: boolean;
}

const DEFAULT_KEY = '\0default';

/** サーバーの launchConfig.ts の adapterForType / adapterForFile と同じ表 */
const adapterForType = (type: string): AdapterId => (type === 'coreclr' ? 'csharp' : 'node');
const adapterForFile = (file: string): AdapterId => (file.toLowerCase().endsWith('.cs') ? 'csharp' : 'node');

function activeFileFor(root: string): string | null {
  const tabs = getFilesTabs().filter((h) => h.root === root);
  return (tabs.find((h) => h.isVisible()) ?? tabs[0])?.getActivePath() ?? null;
}

export default function DebugTab({ root, leafId, visible }: { root: string; leafId: string; visible: boolean }) {
  const t = useT();
  const run = useDebugStore((s) => s.runs[root]);
  const start = useDebugStore((s) => s.start);
  const stop = useDebugStore((s) => s.stop);
  const control = useDebugStore((s) => s.control);
  const [info, setInfo] = useState<ConfigsInfo>({ configs: [], warnings: [], defaultAvailable: false });
  const [selected, setSelected] = useState<string>(DEFAULT_KEY);
  const [activeFile, setActiveFile] = useState<string | null>(null);

  // 表示されるたびに launch.json と「今開いているファイル」を取り直す (設定 UI は無い。ファイルの手編集が入口)。
  // 表示中にエディターのタブが切り替わっても気づけるよう、アクティブファイルだけは 1 秒ごとに見る
  // (ponytail: FilesTab に変更通知は無い。ローカルの getActivePath() だけなので API は変わったときしか叩かない)
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    let current: string | null | undefined;
    const refresh = () => {
      const file = activeFileFor(root);
      if (file === current) return;
      current = file;
      setActiveFile(file);
      api.debugConfigs(root, file ?? '').then(
        (r) => {
          if (!alive || current !== file) return;
          setInfo({ configs: r.configs, warnings: r.warnings, defaultAvailable: r.default.available });
          setSelected((cur) => (cur !== DEFAULT_KEY && r.configs.some((c) => c.name === cur) ? cur : r.configs[0] && !r.default.available ? r.configs[0].name : cur));
        },
        () => alive && setInfo({ configs: [], warnings: [], defaultAvailable: false }),
      );
    };
    refresh();
    const timer = setInterval(refresh, 1_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [root, visible, leafId]);

  const phase = run?.phase ?? 'idle';
  const active = phase === 'starting' || phase === 'running' || phase === 'stopped';
  const choice = (): StartChoice | null => {
    if (selected === DEFAULT_KEY) return info.defaultAvailable && activeFile ? { file: activeFile, request: 'launch', adapter: adapterForFile(activeFile) } : null;
    const c = info.configs.find((x) => x.name === selected);
    return c ? { name: c.name, file: activeFile ?? undefined, request: c.request, adapter: adapterForType(c.type) } : null;
  };
  const canStart = !active && choice() !== null;

  const onStart = () => {
    const c = choice();
    if (c) start(root, c);
  };

  // F5 / F10 / F11 はこのビューにフォーカスがあるときだけ (エディターのキーは奪わない)
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'F5') {
      e.preventDefault();
      if (phase === 'stopped') control(root, 'continue');
      else if (canStart) onStart();
    } else if (e.key === 'F10') {
      e.preventDefault();
      control(root, 'next');
    } else if (e.key === 'F11') {
      e.preventDefault();
      control(root, e.shiftKey ? 'stepOut' : 'stepIn');
    }
  };

  const statusText = (): string => {
    if (!run || phase === 'idle') return t('debug.idle');
    if (phase === 'starting' && run.status?.state && run.status.state !== 'ready') {
      const key = `debug.state.${run.status.state}` as StringKey;
      return key in STATE_KEYS ? t(key) : run.status.state;
    }
    return t(`debug.phase.${phase}` as StringKey) + (run.stopReason && phase === 'stopped' ? ` (${run.stopReason})` : '');
  };

  return (
    <div className="debug-tab" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="debug-toolbar">
        <select className="debug-config" value={selected} onChange={(e) => setSelected(e.target.value)} disabled={active}>
          <option value={DEFAULT_KEY} disabled={!info.defaultAvailable}>
            {t('debug.runActiveFile')}
            {activeFile ? ` — ${activeFile}` : ''}
          </option>
          {info.configs.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} ({c.request})
            </option>
          ))}
        </select>
        {!active ? (
          <button className="icon-btn debug-btn-start" title={t('debug.start')} disabled={!canStart} onClick={onStart}>
            <span className="codicon codicon-debug-start" />
          </button>
        ) : (
          <>
            {phase === 'stopped' ? (
              <button className="icon-btn" title={t('debug.continue')} onClick={() => control(root, 'continue')}>
                <span className="codicon codicon-debug-continue" />
              </button>
            ) : (
              <button className="icon-btn" title={t('debug.pause')} disabled={phase !== 'running'} onClick={() => control(root, 'pause')}>
                <span className="codicon codicon-debug-pause" />
              </button>
            )}
            <button className="icon-btn" title={t('debug.stepOver')} disabled={phase !== 'stopped'} onClick={() => control(root, 'next')}>
              <span className="codicon codicon-debug-step-over" />
            </button>
            <button className="icon-btn" title={t('debug.stepInto')} disabled={phase !== 'stopped'} onClick={() => control(root, 'stepIn')}>
              <span className="codicon codicon-debug-step-into" />
            </button>
            <button className="icon-btn" title={t('debug.stepOut')} disabled={phase !== 'stopped'} onClick={() => control(root, 'stepOut')}>
              <span className="codicon codicon-debug-step-out" />
            </button>
            <button className="icon-btn debug-btn-stop" title={t('debug.stop')} onClick={() => stop(root)}>
              <span className="codicon codicon-debug-stop" />
            </button>
          </>
        )}
        <span className={`debug-status debug-status-${phase}`} title={run?.status?.source ? `adapter: ${run.status.source}` : undefined}>
          {statusText()}
        </span>
      </div>
      {(run?.error || info.warnings.length > 0) && (
        <div className="debug-error" title={info.warnings.join('\n')}>
          {run?.error ?? t('debug.configWarnings', { n: info.warnings.length })}
        </div>
      )}
      {(info.configs.length === 0 && !info.defaultAvailable && !active) && <div className="debug-hint">{t('debug.noConfig')}</div>}
      <div className="debug-panels">
        <section className="debug-section debug-stack">
          <h3>{t('debug.callStack')}</h3>
          <CallStack root={root} run={run} />
        </section>
        <section className="debug-section debug-vars">
          <h3>{t('debug.variables')}</h3>
          <Variables root={root} run={run} />
        </section>
        <section className="debug-section debug-console">
          <h3>
            {t('debug.console')}
            <button className="icon-btn" title={t('debug.clearConsole')} onClick={() => useDebugStore.getState().clearConsole(root)}>
              <span className="codicon codicon-clear-all" />
            </button>
          </h3>
          <Console root={root} run={run} active={active} />
        </section>
      </div>
    </div>
  );
}

const STATE_KEYS: Record<string, true> = { 'debug.state.resolving': true, 'debug.state.downloading': true, 'debug.state.starting': true };

function CallStack({ root, run }: { root: string; run: RunState | undefined }) {
  const t = useT();
  const selectFrame = useDebugStore((s) => s.selectFrame);
  if (!run || run.phase !== 'stopped') return <div className="debug-empty">{t('debug.noFrames')}</div>;
  return (
    <ul className="debug-list">
      {run.frames.map((f: Frame) => (
        <li
          key={f.id}
          className={`debug-frame ${f.id === run.activeFrame ? 'active' : ''} ${f.deemphasize ? 'dim' : ''} ${f.path === null ? 'noopen' : ''}`}
          onClick={() => selectFrame(root, f.id)}
          title={f.path ?? undefined}
        >
          <span className="debug-frame-name">{f.name || '<anonymous>'}</span>
          <span className="debug-frame-loc">
            {f.path ? `${f.path.split('/').pop()}:${f.line}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Variables({ root, run }: { root: string; run: RunState | undefined }) {
  const toggleExpand = useDebugStore((s) => s.toggleExpand);
  if (!run || run.phase !== 'stopped') return null;
  const renderVars = (ref: number, depth: number): React.ReactNode => {
    const vars = run.variables[ref];
    if (!vars) return <li className="debug-var dim" style={{ paddingLeft: depth * 12 + 4 }}>…</li>;
    return vars.map((v: Variable) => {
      const expandable = v.variablesReference > 0;
      const open = run.expanded.includes(v.variablesReference);
      return (
        <li key={`${ref}:${v.name}`} className="debug-var" style={{ paddingLeft: depth * 12 + 4 }}>
          <div className={`debug-var-row ${expandable ? 'expandable' : ''}`} onClick={() => expandable && toggleExpand(root, v.variablesReference)}>
            {expandable && <span className={`codicon ${open ? 'codicon-chevron-down' : 'codicon-chevron-right'}`} />}
            <span className="debug-var-name">{v.name}</span>
            <span className="debug-var-value" title={v.type ? `${v.type}: ${v.value}` : v.value}>
              {v.value}
            </span>
          </div>
          {expandable && open && <ul className="debug-list">{renderVars(v.variablesReference, depth + 1)}</ul>}
        </li>
      );
    });
  };
  return (
    <ul className="debug-list">
      {run.scopes.map((s) => {
        const open = run.expanded.includes(s.variablesReference) || s === run.scopes[0];
        if (open && !run.variables[s.variablesReference] && !run.expanded.includes(s.variablesReference)) {
          // 最初のスコープ (Local) は自動で開く
          queueMicrotask(() => toggleExpand(root, s.variablesReference));
        }
        return (
          <li key={s.variablesReference} className="debug-scope">
            <div className="debug-var-row expandable" onClick={() => toggleExpand(root, s.variablesReference)}>
              <span className={`codicon ${open ? 'codicon-chevron-down' : 'codicon-chevron-right'}`} />
              <span className="debug-var-name">{s.name}</span>
            </div>
            {open && <ul className="debug-list">{renderVars(s.variablesReference, 1)}</ul>}
          </li>
        );
      })}
    </ul>
  );
}

function Console({ root, run, active }: { root: string; run: RunState | undefined; active: boolean }) {
  const t = useT();
  const evaluate = useDebugStore((s) => s.evaluate);
  const listRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState('');
  const lines = run?.console ?? [];
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <>
      <div className="debug-console-lines" ref={listRef}>
        {lines.map((l, i) => (
          <span key={i} className={`debug-line debug-line-${l.category}`}>
            {l.text}
          </span>
        ))}
      </div>
      <input
        className="debug-console-input"
        placeholder={t('debug.consolePlaceholder')}
        value={input}
        disabled={!active}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && input.trim()) {
            evaluate(root, input);
            setInput('');
          }
          e.stopPropagation(); // F5 等の親ハンドラーへは渡さない
        }}
      />
    </>
  );
}
