// Commit-graph lane layout (Sourcetree-style). Input must be in topo order
// (children before parents); each row gets drawing primitives for its SVG cell.

export interface GraphRow {
  dot: number; // lane of the commit's dot
  passing: number[]; // lanes that pass straight through this row
  topToDot: number[]; // lanes coming from the top edge that end at the dot
  dotToBottom: number[]; // lanes leaving the dot toward the bottom edge
  laneCount: number; // lanes needed to render this row
}

export function layoutGraph(entries: { hash: string; parents: string[] }[]): GraphRow[] {
  // lanes[i] = commit hash this lane is waiting to reach (a child above points at it)
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];

  for (const commit of entries) {
    const incoming: number[] = [];
    lanes.forEach((expected, i) => {
      if (expected === commit.hash) incoming.push(i);
    });

    let dot: number;
    if (incoming.length === 0) {
      // branch tip (no child shown above)
      dot = lanes.indexOf(null);
      if (dot === -1) {
        dot = lanes.length;
        lanes.push(null);
      }
    } else {
      dot = incoming[0];
    }

    const passing: number[] = [];
    lanes.forEach((expected, i) => {
      if (expected !== null && !incoming.includes(i)) passing.push(i);
    });

    const [firstParent, ...extraParents] = commit.parents;
    lanes[dot] = firstParent ?? null;
    for (const i of incoming) if (i !== dot) lanes[i] = null;

    const dotToBottom: number[] = [];
    if (firstParent) dotToBottom.push(dot);
    for (const parent of extraParents) {
      const existing = lanes.findIndex((expected) => expected === parent);
      if (existing !== -1) {
        // merge edge joins a lane that already waits for this parent
        dotToBottom.push(existing);
      } else {
        let slot = lanes.indexOf(null);
        if (slot === -1) {
          slot = lanes.length;
          lanes.push(parent);
        } else {
          lanes[slot] = parent;
        }
        dotToBottom.push(slot);
      }
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    rows.push({
      dot,
      passing,
      topToDot: incoming,
      dotToBottom,
      laneCount: Math.max(
        lanes.length,
        dot + 1,
        ...passing.map((l) => l + 1),
        ...incoming.map((l) => l + 1),
        ...dotToBottom.map((l) => l + 1),
      ),
    });
  }
  return rows;
}

export const LANE_COLORS = [
  '#d97757',
  '#4fc1ff',
  '#4ec9b0',
  '#dcdcaa',
  '#c586c0',
  '#ce9178',
  '#569cd6',
  '#89d4a3',
  '#f48771',
  '#dcb67a',
];

export function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}
