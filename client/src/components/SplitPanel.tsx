import { useRef, type ReactNode } from 'react';
import { Panel } from 'react-resizable-panels';

/**
 * A react-resizable-panels Panel whose `defaultSize` is frozen at mount.
 *
 * Why: `defaultSize` is one of the deps of Panel's registration effect, so
 * feeding the live tree sizes back into it makes the panel unregister and
 * re-register on every drag. react-resizable-panels keeps `group.panels` in
 * visual order by re-sorting on each registration using `offsetLeft` /
 * `offsetTop`, while the separator → panel pairing is rebuilt from live DOM
 * order at pointerdown. A drag resolves the pair through
 * `group.panels.indexOf(...)`, so the two orders must agree.
 *
 * Inside a `display: none` subtree (TileWorkspace hides the non-active views)
 * every offset reads 0, the sort ties, and the array keeps *insertion* order.
 * A re-registration of only some panels there permanently reverses the pair
 * until the Group remounts — the drag then resizes the wrong panels, or moves
 * the boundary opposite to the pointer. Measured (2026-08-29, Chrome, v4.12.2):
 * hidden + partial re-registration turned a +60px drag into left −58 / right
 * +58; with the size frozen the same sequence stays +60 / −60.
 *
 * Freezing is safe because both split trees key their Group by structure, so a
 * change in the child set remounts this component and re-reads the tree sizes.
 * While the Group lives, the library's own layout state is the source of truth
 * for the rendered sizes.
 */
export default function SplitPanel({
  id,
  initialSize,
  className,
  children,
}: {
  id: string;
  initialSize: string;
  className: string;
  children: ReactNode;
}) {
  const defaultSize = useRef(initialSize).current;
  return (
    <Panel
      id={id}
      defaultSize={defaultSize}
      minSize="120px"
      className={className}
      style={{ overflow: 'hidden' }}
    >
      {children}
    </Panel>
  );
}
