import { describe, expect, it } from 'vitest';
import { classifyDisconnect, sanitizePaneWidth } from './vncState';

describe('classifyDisconnect', () => {
  it('maps security failure to authFailed regardless of other flags', () => {
    expect(
      classifyDisconnect({ everConnected: false, securityReason: 'Auth failed', probeReachable: true }),
    ).toEqual({ phase: 'disconnected', messageKey: 'vnc.authFailed' });
    expect(
      classifyDisconnect({ everConnected: true, securityReason: 'Auth failed', probeReachable: false }),
    ).toEqual({ phase: 'disconnected', messageKey: 'vnc.authFailed' });
  });

  it('maps a drop after connection to disconnected', () => {
    expect(
      classifyDisconnect({ everConnected: true, securityReason: null, probeReachable: null }),
    ).toEqual({ phase: 'disconnected', messageKey: 'vnc.disconnected' });
  });

  it('maps never-connected + unreachable probe to the setup guide', () => {
    expect(
      classifyDisconnect({ everConnected: false, securityReason: null, probeReachable: false }),
    ).toEqual({ phase: 'unreachable', messageKey: null });
  });

  it('maps never-connected but reachable (handshake failure) to connectFailed', () => {
    for (const probeReachable of [true, null]) {
      expect(
        classifyDisconnect({ everConnected: false, securityReason: null, probeReachable }),
      ).toEqual({ phase: 'disconnected', messageKey: 'vnc.connectFailed' });
    }
  });
});

describe('sanitizePaneWidth', () => {
  it('returns the fallback for garbage input', () => {
    for (const raw of [null, undefined, 'abc', '', NaN, Infinity, {}, []]) {
      expect(sanitizePaneWidth(raw)).toBe(560);
    }
  });

  it('clamps to [320, 2000] and rounds', () => {
    expect(sanitizePaneWidth(100)).toBe(320);
    expect(sanitizePaneWidth('5000')).toBe(2000);
    expect(sanitizePaneWidth(640.6)).toBe(641);
    expect(sanitizePaneWidth('800')).toBe(800);
  });
});
