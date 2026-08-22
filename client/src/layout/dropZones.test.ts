import { describe, expect, it } from 'vitest';
import { tabInsertionIndex, zoneFromPoint } from './dropZones';

const rect = { left: 0, top: 0, width: 100, height: 100 };

describe('zoneFromPoint', () => {
  it('中央 50%×50% は center', () => {
    expect(zoneFromPoint(rect, 50, 50)).toBe('center');
    expect(zoneFromPoint(rect, 26, 26)).toBe('center');
    expect(zoneFromPoint(rect, 74, 74)).toBe('center');
  });

  it('端に最も近い辺が勝つ', () => {
    expect(zoneFromPoint(rect, 10, 50)).toBe('left');
    expect(zoneFromPoint(rect, 90, 50)).toBe('right');
    expect(zoneFromPoint(rect, 50, 10)).toBe('top');
    expect(zoneFromPoint(rect, 50, 90)).toBe('bottom');
  });

  it('rect のオフセットを考慮する', () => {
    const off = { left: 200, top: 100, width: 100, height: 100 };
    expect(zoneFromPoint(off, 250, 150)).toBe('center');
    expect(zoneFromPoint(off, 210, 150)).toBe('left');
  });

  it('タイは left → right → top → bottom の順に解決 (旧 TilePane 実装と同じ)', () => {
    // 四隅 (x === y === 対辺距離のタイ)
    expect(zoneFromPoint(rect, 0, 0)).toBe('left');
    expect(zoneFromPoint(rect, 100, 0)).toBe('right');
    expect(zoneFromPoint(rect, 100, 100)).toBe('right');
  });
});

describe('tabInsertionIndex', () => {
  const midpoints = [10, 30, 50]; // 3 タブの中心 x
  it('ポインターより左にある中心の数が挿入 index', () => {
    expect(tabInsertionIndex(midpoints, 5)).toBe(0);
    expect(tabInsertionIndex(midpoints, 20)).toBe(1);
    expect(tabInsertionIndex(midpoints, 40)).toBe(2);
    expect(tabInsertionIndex(midpoints, 99)).toBe(3);
  });
  it('空ストリップは常に 0', () => {
    expect(tabInsertionIndex([], 42)).toBe(0);
  });
});
