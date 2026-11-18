import { Point, Size } from './node-geometry';

/** Something to place: its size, plus where it is now (used to keep the new order close to the old). */
export interface LayoutItem extends Point, Size {
  id: string;
}

/** A prereq link between two items: `from` must come before `to`. */
export interface LayoutEdge {
  from: string;
  to: string;
}

export interface LayoutOptions {
  /** Horizontal space between columns (and between cells of the unlinked grid). */
  gapX: number;
  /** Vertical space between items in a column (and between rows of the unlinked grid). */
  gapY: number;
}

/**
 * Which item goes where, without positions: linked items in columns (left to right, each
 * top to bottom), and the unlinked ones in reading order for the grid below. Kept separate from
 * the positions so the same arrangement can be re-spaced or reordered.
 */
export interface LayoutPlan {
  columns: string[][];
  loose: string[];
  /** Items per row in the unlinked grid; defaults to a roughly square grid. */
  perRow?: number;
}

/** The space between two neighbours: `x` gaps sit between columns/cells, `y` gaps between stacked items/rows. */
export interface GapRect extends Point, Size {
  axis: 'x' | 'y';
}

export interface Placement {
  /** Each item's top-left, relative to (0, 0) as the top-left of the whole layout. */
  positions: Map<string, Point>;
  gaps: GapRect[];
  width: number;
  height: number;
  /** The unlinked grid, if there is one: where it starts, its cell width and how many items per row. */
  grid: { x: number; y: number; cellWidth: number; cellHeight: number; perRow: number; count: number } | null;
}

/**
 * Plans a left-to-right layout along the items' prereq links: items with no prereqs (within the
 * set) in the first column, items that depend on them in the next, and so on — each after the
 * longest chain leading to it. Columns are ordered to limit crossings. Items with no links to the
 * others are left for a grid below.
 */
export function planLayout(items: LayoutItem[], edges: LayoutEdge[]): LayoutPlan {
  const ids = new Set(items.map(i => i.id));
  const readingOrder = (a: LayoutItem, b: LayoutItem) => a.y - b.y || a.x - b.x;

  // Only links between two different items in the set, once each.
  const seen = new Set<string>();
  const links = edges.filter(e => {
    const key = `${e.from}\u0000${e.to}`;
    if (e.from === e.to || !ids.has(e.from) || !ids.has(e.to) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const linked = new Set(links.flatMap(e => [e.from, e.to]));
  const connected = items.filter(i => linked.has(i.id)).sort(readingOrder).map(i => i.id);
  const loose = items.filter(i => !linked.has(i.id)).sort(readingOrder).map(i => i.id);
  if (!connected.length) return { columns: [], loose };

  const dag = breakCycles(connected, links);
  const columns = assignColumns(connected, dag);
  orderColumns(columns, dag);
  return { columns, loose };
}

/**
 * Positions a plan: columns side by side, each stacked and centred vertically against the
 * tallest; the unlinked items in a roughly square grid below. Also reports the gaps between
 * neighbours (for spacing handles).
 */
export function placeLayout(plan: LayoutPlan, sizes: ReadonlyMap<string, Size>, opts: LayoutOptions): Placement {
  const positions = new Map<string, Point>();
  const gaps: GapRect[] = [];
  const size = (id: string) => sizes.get(id)!;
  let width = 0;
  let blockHeight = 0;

  if (plan.columns.length) {
    const heightOf = (col: string[]) => col.reduce((h, id) => h + size(id).height, 0) + opts.gapY * (col.length - 1);
    blockHeight = Math.max(...plan.columns.map(heightOf));

    let x = 0;
    plan.columns.forEach((col, c) => {
      const colW = Math.max(...col.map(id => size(id).width));
      let y = (blockHeight - heightOf(col)) / 2;
      col.forEach((id, r) => {
        positions.set(id, { x, y });
        y += size(id).height;
        if (r < col.length - 1) gaps.push({ axis: 'y', x, y, width: colW, height: opts.gapY });
        y += opts.gapY;
      });
      if (c < plan.columns.length - 1) gaps.push({ axis: 'x', x: x + colW, y: 0, width: opts.gapX, height: blockHeight });
      x += colW + opts.gapX;
    });
    width = x - opts.gapX;
  }

  let height = blockHeight;
  let grid: Placement['grid'] = null;
  if (plan.loose.length) {
    const perRow = Math.min(plan.loose.length, Math.max(1, plan.perRow ?? Math.ceil(Math.sqrt(plan.loose.length))));
    const cellW = Math.max(...plan.loose.map(id => size(id).width));
    const gridW = Math.min(perRow, plan.loose.length) * (cellW + opts.gapX) - opts.gapX;
    // Rows take the height of their tallest item, so mixed sizes don't overlap.
    let y = plan.columns.length ? blockHeight + opts.gapY * 2 : 0;
    grid = { x: 0, y, cellWidth: cellW, cellHeight: Math.max(...plan.loose.map(id => size(id).height)), perRow, count: plan.loose.length };
    for (let r = 0; r * perRow < plan.loose.length; r++) {
      const row = plan.loose.slice(r * perRow, (r + 1) * perRow);
      const rowH = Math.max(...row.map(id => size(id).height));
      row.forEach((id, c) => {
        const x = c * (cellW + opts.gapX);
        positions.set(id, { x, y });
        if (c < row.length - 1) gaps.push({ axis: 'x', x: x + cellW, y, width: opts.gapX, height: rowH });
      });
      y += rowH;
      if ((r + 1) * perRow < plan.loose.length) gaps.push({ axis: 'y', x: 0, y, width: gridW, height: opts.gapY });
      y += opts.gapY;
    }
    height = y - opts.gapY;
    width = Math.max(width, gridW);
  }

  return { positions, gaps, width, height, grid };
}

/** Plans and places in one go; returns each item's new top-left relative to the layout's top-left. */
export function layeredLayout(items: LayoutItem[], edges: LayoutEdge[], opts: LayoutOptions): Map<string, Point> {
  return placeLayout(planLayout(items, edges), new Map(items.map(i => [i.id, i])), opts).positions;
}

/** Whether two items share a column, or are both in the unlinked grid — the places a reorder may swap between. */
export function canSwap(plan: LayoutPlan, a: string, b: string): boolean {
  if (a === b) return false;
  if (plan.loose.includes(a)) return plan.loose.includes(b);
  return plan.columns.some(col => col.includes(a) && col.includes(b));
}

/**
 * How many cells (cell size + gap per step) fit wholly inside a dragged edge at `length`, clamped
 * to 1..max: a cell drops out as soon as the edge touches it, and comes back once the edge clears
 * it. Depends only on where the edge is (not the current count), so it can't flip-flop.
 */
export function cellsInLength(length: number, cell: number, gap: number, max: number): number {
  return Math.min(max, Math.max(1, Math.floor((length + gap) / (cell + gap) + 1e-6)));
}

/** How many grid items per row fit inside a grid edge dragged to `right` (relative to the grid's left). */
export function perRowForWidth(grid: NonNullable<Placement['grid']>, right: number, gapX: number): number {
  return cellsInLength(right, grid.cellWidth, gapX, grid.count);
}

/** A copy of the plan with two items' places swapped. */
export function swapInPlan(plan: LayoutPlan, a: string, b: string): LayoutPlan {
  const swap = (id: string) => (id === a ? b : id === b ? a : id);
  return { ...plan, columns: plan.columns.map(col => col.map(swap)), loose: plan.loose.map(swap) };
}

/** Drops the links that close a loop (found by a depth-first walk in reading order), leaving a DAG. */
function breakCycles(ids: string[], links: LayoutEdge[]): LayoutEdge[] {
  const out = new Map<string, LayoutEdge[]>();
  for (const e of links) out.set(e.from, [...(out.get(e.from) ?? []), e]);

  const state = new Map<string, 'active' | 'done'>();
  const kept: LayoutEdge[] = [];
  const visit = (id: string) => {
    state.set(id, 'active');
    for (const e of out.get(id) ?? []) {
      const s = state.get(e.to);
      if (s === 'active') continue; // back edge: closes a loop
      kept.push(e);
      if (!s) visit(e.to);
    }
    state.set(id, 'done');
  };
  for (const id of ids) if (!state.has(id)) visit(id);
  return kept;
}

/** Each item's column is the length of the longest prereq chain leading to it. */
function assignColumns(ids: string[], dag: LayoutEdge[]): string[][] {
  const indegree = new Map(ids.map(id => [id, 0]));
  for (const e of dag) indegree.set(e.to, indegree.get(e.to)! + 1);

  const col = new Map(ids.map(id => [id, 0]));
  const queue = ids.filter(id => indegree.get(id) === 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of dag) {
      if (e.from !== id) continue;
      col.set(e.to, Math.max(col.get(e.to)!, col.get(id)! + 1));
      indegree.set(e.to, indegree.get(e.to)! - 1);
      if (indegree.get(e.to) === 0) queue.push(e.to);
    }
  }

  const columns: string[][] = [];
  for (const id of ids) (columns[col.get(id)!] ??= []).push(id); // ids arrive in reading order
  return columns.filter(Boolean);
}

/** Reorders each column so items sit near the average position of what they link to (fewer crossings). */
function orderColumns(columns: string[][], dag: LayoutEdge[]): void {
  const neighbours = (id: string, dir: 'prev' | 'next') =>
    dir === 'prev' ? dag.filter(e => e.to === id).map(e => e.from) : dag.filter(e => e.from === id).map(e => e.to);

  const sortBy = (col: string[], dir: 'prev' | 'next', index: Map<string, number>) => {
    const score = new Map<string, number>();
    col.forEach((id, i) => {
      const ns = neighbours(id, dir).filter(n => index.has(n));
      score.set(id, ns.length ? ns.reduce((s, n) => s + index.get(n)!, 0) / ns.length : i);
    });
    col.sort((a, b) => score.get(a)! - score.get(b)!); // stable, so ties keep their order
  };

  const indexOf = (col: string[]) => new Map(col.map((id, i) => [id, i]));
  for (let pass = 0; pass < 4; pass++) {
    for (let c = 1; c < columns.length; c++) sortBy(columns[c], 'prev', indexOf(columns[c - 1]));
    for (let c = columns.length - 2; c >= 0; c--) sortBy(columns[c], 'next', indexOf(columns[c + 1]));
  }
}
