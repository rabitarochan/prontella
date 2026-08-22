// Pure drop-target geometry, shared by tile DnD (TilePane) and editor-tab DnD
// (components/files). No DOM types — callers pass the rect/coordinates so this
// stays vitest-testable.

export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';

/**
 * 5-zone hit test over a rectangle: the middle 50%×50% is 'center', otherwise
 * the nearest edge wins (ties resolve left → right → top → bottom, matching
 * the original TilePane implementation).
 */
export function zoneFromPoint(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): DropZone {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x > 0.25 && x < 0.75 && y > 0.25 && y < 0.75) return 'center';
  const m = Math.min(x, 1 - x, y, 1 - y);
  return m === x ? 'left' : m === 1 - x ? 'right' : m === y ? 'top' : 'bottom';
}

/**
 * Insertion index for a tab dragged over a horizontal tab strip: the number of
 * tab midpoints (x centers, in strip order) left of the pointer. Dropping past
 * the last midpoint appends (returns midpoints.length).
 */
export function tabInsertionIndex(midpoints: number[], clientX: number): number {
  let i = 0;
  for (const m of midpoints) if (clientX > m) i++;
  return i;
}
