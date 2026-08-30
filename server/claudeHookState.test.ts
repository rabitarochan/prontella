import { describe, expect, it } from 'vitest';
import {
  applyClaudeHookEvent,
  isClaudeHookPayload,
  clearWork,
  createHookState,
  deriveStatus,
  subagentList,
  type ClaudeHookState,
} from './claudeHookState.js';

// Phase 0 の実測 (2026-08-30 / claude 2.1.251 / HTTP hook) をフィクスチャにしてある。
// 判別器は agent_id の有無だけ — session_id も transcript_path も親子で同一だった。

const AF = 'af2617a26a1dd9bd8'; // Explore #1
const AB = 'ab12b8fa0a193cf8f'; // Explore #2

function task(id: string, status: string, type = 'subagent'): Record<string, unknown> {
  return { id, type, status, agent_type: 'Explore', description: 'work ' + id.slice(0, 4) };
}

function feed(state: ClaudeHookState, payload: Record<string, unknown>, now = 1_000) {
  return applyClaudeHookEvent(state, payload, now);
}

function fresh(): ClaudeHookState {
  return createHookState(0);
}

describe('親子の判別', () => {
  it('agent_id を持たないツールイベントはリードの状態とツールカードを更新する', () => {
    const state = fresh();
    const r = feed(state, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    expect(r.status).toBe('busy');
    expect(state.lead).toBe('working');
    expect(state.tool).toEqual({ name: 'Bash', detail: 'Bash: npm test', since: 1_000 });
    expect(state.subagents.size).toBe(0);
  });

  it('agent_id を持つツールイベントはリードを書き換えず子の行だけを更新する', () => {
    const state = fresh();
    feed(state, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    feed(state, { hook_event_name: 'Stop', background_tasks: [task(AF, 'running')] });
    expect(state.lead).toBe('idle');

    feed(state, {
      hook_event_name: 'PreToolUse',
      agent_id: AF,
      agent_type: 'Explore',
      tool_name: 'Grep',
      tool_input: { pattern: 'hooks' },
    });
    // リードは idle のまま。ペインは子が居るので busy。
    expect(state.lead).toBe('idle');
    expect(deriveStatus(state)).toBe('busy');
    expect(subagentList(state)[0].activity).toBe('Grep: hooks');
  });
});

describe('完了ゲート (Stop + background_tasks)', () => {
  it('リードの Stop でも走行中の子が居れば busy を維持する', () => {
    const state = fresh();
    feed(state, { hook_event_name: 'SubagentStart', agent_id: AF, agent_type: 'Explore' });
    const r = feed(state, {
      hook_event_name: 'Stop',
      background_tasks: [task(AF, 'running')],
    });
    expect(r.status).toBe('busy');
  });

  it('background_tasks が空なら idle へ落とす', () => {
    const state = fresh();
    feed(state, { hook_event_name: 'SubagentStart', agent_id: AF, agent_type: 'Explore' });
    const r = feed(state, { hook_event_name: 'Stop', background_tasks: [] });
    expect(r.status).toBe('idle');
    expect(state.subagents.size).toBe(0);
  });

  it('SubagentStop を取りこぼしても、載っていない子は Stop の畳み込みで回収される', () => {
    const state = fresh();
    feed(state, { hook_event_name: 'SubagentStart', agent_id: AF, agent_type: 'Explore' });
    feed(state, { hook_event_name: 'SubagentStart', agent_id: AB, agent_type: 'Explore' });
    const r = feed(state, { hook_event_name: 'Stop', background_tasks: [task(AF, 'running')] });
    expect(r.status).toBe('busy');
    expect(subagentList(state).map((s) => s.id)).toEqual([AF]);
  });

  it('終了状態の載り方 (status: completed) は行を消す', () => {
    const state = fresh();
    feed(state, { hook_event_name: 'SubagentStart', agent_id: AF, agent_type: 'Explore' });
    const r = feed(state, { hook_event_name: 'Stop', background_tasks: [task(AF, 'completed')] });
    expect(r.status).toBe('idle');
  });

  it('background_tasks が無い版では roster を保つ (畳み込まない)', () => {
    const state = fresh();
    feed(state, { hook_event_name: 'SubagentStart', agent_id: AF, agent_type: 'Explore' });
    const r = feed(state, { hook_event_name: 'Stop' });
    expect(r.status).toBe('busy');
    expect(state.subagents.size).toBe(1);
  });

  it('SubagentStop の background_tasks は畳み込まない (停止した当人が running のまま載るため)', () => {
    const state = fresh();
    feed(state, { hook_event_name: 'SubagentStart', agent_id: AF, agent_type: 'Explore' });
    feed(state, { hook_event_name: 'Stop', background_tasks: [task(AF, 'running')] });
    // 実測 (capture-A index 14): 停止通知に自分自身が running で載っている
    const r = feed(state, {
      hook_event_name: 'SubagentStop',
      agent_id: AF,
      background_tasks: [task(AF, 'running')],
    });
    expect(state.subagents.size).toBe(0);
    expect(r.status).toBe('idle');
  });

  it('teammate 型のタスクは完了ゲートに入れない (恒久 running を報告しうるため)', () => {
    const state = fresh();
    const r = feed(state, {
      hook_event_name: 'Stop',
      background_tasks: [task('t1', 'running', 'teammate')],
    });
    expect(r.status).toBe('idle');
    expect(state.subagents.size).toBe(0);
  });

  it('サブエージェント以外の走行中タスクは busy を固着させず、フラグにだけ立つ', () => {
    const state = fresh();
    const r = feed(state, {
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'b1', type: 'bash', status: 'running' }],
    });
    expect(r.status).toBe('idle');
    expect(state.runningBackgroundTask).toBe(true);
  });
});

describe('実測シーケンスの再生 (capture-A: Read + Explore 並列 2 本)', () => {
  it('子が全部終わるまで busy を維持し、最後の Stop で idle になる', () => {
    const state = fresh();
    const both = [task(AF, 'running'), task(AB, 'running')];
    const seen: (string | null)[] = [];
    const step = (payload: Record<string, unknown>) => seen.push(feed(state, payload).status);

    step({ hook_event_name: 'UserPromptSubmit' }); // 0
    step({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'hello.txt' } }); // 1
    step({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'list files' } }); // 2
    step({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'size' } }); // 3
    step({ hook_event_name: 'SubagentStart', agent_id: AF, agent_type: 'Explore' }); // 4
    step({ hook_event_name: 'PostToolUse', tool_name: 'Agent' }); // 5
    step({ hook_event_name: 'SubagentStart', agent_id: AB, agent_type: 'Explore' }); // 6
    step({ hook_event_name: 'PostToolUse', tool_name: 'Agent' }); // 7
    step({ hook_event_name: 'PostToolUse', tool_name: 'Read' }); // 8
    step({ hook_event_name: 'PreToolUse', agent_id: AB, agent_type: 'Explore', tool_name: 'Read' }); // 9
    step({ hook_event_name: 'PreToolUse', agent_id: AF, agent_type: 'Explore', tool_name: 'Glob' }); // 10
    step({ hook_event_name: 'Stop', background_tasks: both }); // 11 <- リードのターン終了
    step({ hook_event_name: 'PostToolUse', agent_id: AB, tool_name: 'Read' }); // 12
    step({ hook_event_name: 'PostToolUse', agent_id: AF, tool_name: 'Glob' }); // 13
    step({ hook_event_name: 'SubagentStop', agent_id: AF, background_tasks: both }); // 14
    step({ hook_event_name: 'UserPromptSubmit' }); // 15
    step({ hook_event_name: 'SubagentStop', agent_id: AB, background_tasks: [task(AB, 'running')] }); // 16
    step({ hook_event_name: 'Stop', background_tasks: [task(AB, 'running')] }); // 17
    step({ hook_event_name: 'UserPromptSubmit' }); // 18
    step({ hook_event_name: 'Stop', background_tasks: [] }); // 19

    // index 11 のリード Stop は「実行中」のまま。旧実装はここで idle にしていた。
    expect(seen[11]).toBe('busy');
    expect(seen.slice(0, 19).every((s) => s === 'busy')).toBe(true);
    expect(seen[19]).toBe('idle');

    const end = feed(state, { hook_event_name: 'SessionEnd', reason: 'other' });
    expect(end.status).toBe('shell');
    expect(state.subagents.size).toBe(0);
  });

  it('index 17 の時点では子が 1 本だけ残っている', () => {
    const state = fresh();
    feed(state, { hook_event_name: 'SubagentStart', agent_id: AF, agent_type: 'Explore' });
    feed(state, { hook_event_name: 'SubagentStart', agent_id: AB, agent_type: 'Explore' });
    feed(state, { hook_event_name: 'SubagentStop', agent_id: AF });
    const r = feed(state, { hook_event_name: 'Stop', background_tasks: [task(AB, 'running')] });
    expect(r.status).toBe('busy');
    expect(subagentList(state).map((s) => s.id)).toEqual([AB]);
  });
});

describe('待ち状態', () => {
  it('リードの PermissionRequest は waiting', () => {
    const state = fresh();
    expect(feed(state, { hook_event_name: 'PermissionRequest', tool_name: 'Bash' }).status).toBe('waiting');
  });

  it('子の PermissionRequest はペイン全体を waiting にする (人の対応が要るため)', () => {
    const state = fresh();
    feed(state, { hook_event_name: 'SubagentStart', agent_id: AF, agent_type: 'Explore' });
    const r = feed(state, { hook_event_name: 'PermissionRequest', agent_id: AF, tool_name: 'Bash' });
    expect(r.status).toBe('waiting');
  });

  it('waiting は走行中の子より優先される', () => {
    const state = fresh();
    feed(state, { hook_event_name: 'SubagentStart', agent_id: AF, agent_type: 'Explore' });
    feed(state, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    expect(deriveStatus(state)).toBe('waiting');
  });

  it('Notification の種別マッピングを保つ', () => {
    const state = fresh();
    expect(feed(state, { hook_event_name: 'Notification', notification_type: 'idle_prompt' }).status).toBe('idle');
    expect(feed(state, { hook_event_name: 'Notification', notification_type: 'agent_needs_input' }).status).toBe('waiting');
    expect(feed(state, { hook_event_name: 'Notification', notification_type: 'elicitation_dialog' }).status).toBe('waiting');
    // notification_type を持たない旧版は message の正規表現にフォールバックする
    expect(feed(state, { hook_event_name: 'Notification', message: 'Claude needs your permission' }).status).toBe('waiting');
    expect(feed(state, { hook_event_name: 'Notification', message: 'Claude is waiting for your input' }).status).toBe('idle');
  });
});

describe('セッション境界', () => {
  it('SessionStart は前のセッションの子を引き継がない', () => {
    const state = fresh();
    feed(state, { hook_event_name: 'SubagentStart', agent_id: AF, agent_type: 'Explore' });
    const r = feed(state, { hook_event_name: 'SessionStart', source: 'startup' });
    expect(r.status).toBe('idle');
    expect(state.subagents.size).toBe(0);
  });

  it('手動 /compact (PostCompact) だけが解除信号になる。auto は何もしない', () => {
    const state = fresh();
    feed(state, { hook_event_name: 'UserPromptSubmit' });
    expect(feed(state, { hook_event_name: 'PostCompact', trigger: 'auto' }).status).toBe('busy');
    expect(feed(state, { hook_event_name: 'PostCompact', trigger: 'manual' }).status).toBe('idle');
  });

  it('clearWork は hook 断のセッションを idle に回収する', () => {
    const state = fresh();
    feed(state, { hook_event_name: 'SubagentStart', agent_id: AF, agent_type: 'Explore' });
    expect(deriveStatus(state)).toBe('busy');
    clearWork(state);
    expect(deriveStatus(state)).toBe('idle');
    expect(state.subagents.size).toBe(0);
  });
});

describe('信頼できない入力', () => {
  it('制御バイトを含む tool_input を 1 行に潰す', () => {
    const state = fresh();
    const ctl = (code: number) => String.fromCharCode(code);
    feed(state, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {
        // ソースに生の制御バイトを埋めない (差分で見えず、他のツールに誤検出される)。
        // タブ/改行は空白へ、垂直タブ・NUL・DEL は除去されること。
        command: ['echo a', ctl(0x0b), 'b', ctl(0x00), 'c', ctl(0x09), 'd', ctl(0x0a), 'e', ctl(0x7f)].join(''),
      },
    });
    expect(state.tool?.detail).toBe('Bash: echo abc d e');
  });

  it('長いファイルパスは末尾を残して切り詰める (どのファイルか分かるように)', () => {
    const state = fresh();
    const deep = 'C:/Users/someone/Documents/Workspace/project/server/nested/deeper/target.ts';
    feed(state, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: deep } });
    expect(state.tool!.detail.startsWith('Read: ...')).toBe(true);
    expect(state.tool!.detail.endsWith('target.ts')).toBe(true);
  });

  it('長すぎる値を切り詰める', () => {
    const state = fresh();
    feed(state, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'x'.repeat(500) },
    });
    expect(state.tool!.detail.length).toBeLessThanOrEqual(70);
  });

  it('サブエージェント数に上限がある', () => {
    const state = fresh();
    for (let i = 0; i < 50; i++) {
      feed(state, { hook_event_name: 'SubagentStart', agent_id: 'a' + i, agent_type: 'Explore' });
    }
    expect(state.subagents.size).toBe(20);
  });

  it('型が違うフィールドで壊れない', () => {
    const state = fresh();
    expect(() =>
      feed(state, {
        hook_event_name: 'Stop',
        background_tasks: [null, 'x', 42, { id: 1 }, { id: 'ok', type: 'subagent', status: 'running' }],
      }),
    ).not.toThrow();
    expect(subagentList(state).map((s) => s.id)).toEqual(['ok']);
  });

  it('hook として解釈できない本文を弾く (ヒューリスティック無効化の踏み台にさせない)', () => {
    expect(isClaudeHookPayload({ hook_event_name: 'Stop' })).toBe(true);
    expect(isClaudeHookPayload({ hook_event_name: 'AnythingNew' })).toBe(true);
    expect(isClaudeHookPayload({})).toBe(false);
    expect(isClaudeHookPayload({ hook_event_name: '' })).toBe(false);
    expect(isClaudeHookPayload({ hook_event_name: 42 })).toBe(false);
    expect(isClaudeHookPayload({ event: 'Stop' })).toBe(false);
  });

  it('未知のイベント名は状態を変えない', () => {
    const state = fresh();
    feed(state, { hook_event_name: 'UserPromptSubmit' });
    const r = feed(state, { hook_event_name: 'SomethingNew' });
    expect(r.changed).toBe(false);
    expect(r.status).toBe('busy');
  });
});
