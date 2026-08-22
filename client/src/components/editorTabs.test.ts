import type { MouseEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { middleClickAutoscrollGuard, middleClickClose, toPosixPath } from './editorTabs';

describe('toPosixPath', () => {
  it('Windows root をスラッシュ区切りに変換して結合する', () => {
    expect(toPosixPath('C:\\Users\\dev\\repo', 'src/a.ts')).toBe('C:/Users/dev/repo/src/a.ts');
  });

  it('POSIX root はそのまま結合する', () => {
    expect(toPosixPath('/home/dev/repo', 'src/a.ts')).toBe('/home/dev/repo/src/a.ts');
  });

  it('root 末尾の区切りは重複させない', () => {
    expect(toPosixPath('C:\\repo\\', 'a.ts')).toBe('C:/repo/a.ts');
    expect(toPosixPath('/repo/', 'a.ts')).toBe('/repo/a.ts');
  });

  it('rel が空なら root だけを返す', () => {
    expect(toPosixPath('C:\\repo', '')).toBe('C:/repo');
  });
});

function fakeMouseEvent(button: number): MouseEvent {
  return { button, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as MouseEvent;
}

describe('middleClickAutoscrollGuard', () => {
  it('calls preventDefault only for the middle button (1)', () => {
    const e = fakeMouseEvent(1);
    middleClickAutoscrollGuard.onMouseDown(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it.each([0, 2, 3, 4])('does not call preventDefault for button %i', (button) => {
    const e = fakeMouseEvent(button);
    middleClickAutoscrollGuard.onMouseDown(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe('middleClickClose', () => {
  it('calls onClose and stopPropagation exactly once for the middle button (1)', () => {
    const onClose = vi.fn();
    const e = fakeMouseEvent(1);
    middleClickClose(onClose).onAuxClick(e);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(e.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it.each([0, 2, 3, 4])('calls neither onClose nor stopPropagation for button %i', (button) => {
    const onClose = vi.fn();
    const e = fakeMouseEvent(button);
    middleClickClose(onClose).onAuxClick(e);
    expect(onClose).not.toHaveBeenCalled();
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });
});
