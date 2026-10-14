import { describe, expect, it } from 'vitest';
import { CONSOLE_MAX, applyBreakpointResponse, emptyRun, parseStoredBreakpoints, reduceEvent, toggleLines, type RunState } from './store';

describe('toggleLines', () => {
  it('追加はソート、削除で空ならキーごと消す', () => {
    let b = toggleLines({}, 'a.js', 5);
    b = toggleLines(b, 'a.js', 2);
    expect(b).toEqual({ 'a.js': [2, 5] });
    b = toggleLines(b, 'a.js', 5);
    b = toggleLines(b, 'a.js', 2);
    expect(b).toEqual({});
  });
});

describe('parseStoredBreakpoints', () => {
  it('壊れた値・不正な path・不正な行を落とす', () => {
    expect(parseStoredBreakpoints(null)).toEqual({});
    expect(parseStoredBreakpoints('{')).toEqual({});
    expect(parseStoredBreakpoints('[1]')).toEqual({});
    expect(parseStoredBreakpoints(JSON.stringify({ 'a.js': [3, 1, 1, 0, -2, 'x', 2.5], '../x': [1], '/abs': [1], '': [1], 'b.js': 'no' }))).toEqual({ 'a.js': [1, 3] });
  });
});

describe('reduceEvent', () => {
  const root: RunState = { ...emptyRun(), phase: 'starting' };
  it('session → stopped → continued → terminated', () => {
    let r = reduceEvent(root, null, 'prontella/session', { sessionId: 's1', parentSessionId: null });
    expect(r).toMatchObject({ phase: 'running', rootSession: 's1', sessions: ['s1'] });
    r = reduceEvent(r, null, 'prontella/session', { sessionId: 's2', parentSessionId: 's1' });
    r = reduceEvent(r, 's2', 'stopped', { threadId: 0, reason: 'breakpoint' });
    expect(r).toMatchObject({ phase: 'stopped', activeSession: 's2', activeThread: 0, stopReason: 'breakpoint' });
    expect(reduceEvent(r, 's1', 'continued', {})).toBe(r); // 別セッションの continued は無視
    r = reduceEvent({ ...r, currentLine: { path: 'a.js', line: 3 } }, 's2', 'continued', {});
    expect(r).toMatchObject({ phase: 'running', currentLine: null });
    r = reduceEvent(r, 's2', 'terminated', {});
    expect(r).toMatchObject({ phase: 'running', sessions: ['s1'] });
    r = reduceEvent(r, 's1', 'terminated', {});
    expect(r.phase).toBe('terminated');
  });
  it('子が停止中に終了したら running に戻る', () => {
    let r = reduceEvent(root, null, 'prontella/session', { sessionId: 's1', parentSessionId: null });
    r = reduceEvent(r, null, 'prontella/session', { sessionId: 's2', parentSessionId: 's1' });
    r = reduceEvent(r, 's2', 'stopped', { threadId: 0 });
    r = reduceEvent(r, 's2', 'exited', {});
    expect(r).toMatchObject({ phase: 'running', activeSession: null });
  });
  it('status failed/exited は terminated', () => {
    expect(reduceEvent(root, null, 'prontella/status', { state: 'downloading' })).toMatchObject({ phase: 'starting', status: { state: 'downloading' } });
    expect(reduceEvent(root, null, 'prontella/status', { state: 'failed', error: 'x' })).toMatchObject({ phase: 'terminated', error: 'x' });
  });
  it('output は上限で先頭を落とす', () => {
    let r = root;
    for (let i = 0; i < CONSOLE_MAX + 5; i++) r = reduceEvent(r, 's1', 'output', { category: 'stdout', output: `${i}\n` });
    expect(r.console).toHaveLength(CONSOLE_MAX);
    expect(r.console[0]!.text).toBe('5\n');
    expect(reduceEvent(root, 's1', 'output', { output: '' })).toBe(root);
  });
  it('breakpoint changed は id で引き、要求行はそのまま', () => {
    let r = applyBreakpointResponse(root, 'a.js', [3, 7], [{ id: 1, verified: false }, { id: 1, verified: false }]);
    expect(r.verified).toEqual({ 'a.js': { 3: { id: 1, verified: false, line: 3 }, 7: { id: 1, verified: false, line: 7 } } });
    r = reduceEvent(r, 's2', 'breakpoint', { reason: 'changed', breakpoint: { id: 1, verified: true, line: 6 } });
    expect(r.verified['a.js']).toEqual({ 3: { id: 1, verified: true, line: 6 }, 7: { id: 1, verified: true, line: 6 } });
    expect(reduceEvent(r, 's2', 'breakpoint', { breakpoint: { id: 99, verified: true } })).toBe(r);
  });
});
