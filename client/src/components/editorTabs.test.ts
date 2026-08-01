import type { MouseEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { middleClickAutoscrollGuard, middleClickClose } from './editorTabs';

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
