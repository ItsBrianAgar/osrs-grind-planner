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
  /** Horizontal space between columns. */
  gapX: number;
  /** Vertical space between items in a column (and between rows of unconnected items). */
  gapY: number;
}

/**
 * Lays items out left-to-right along their prereq links: items with no prereqs (within the set) in
 * the first column, items that depend on them in the next, and so on. Each column is centred
 * vertically against the tallest. Items with no links to the others are packed in a grid below.
 * Returns each item's new top-left, relative to (0, 0) as the top-left of the whole layout.
 */
export function layeredLayout(items: LayoutItem[], edges: LayoutEdge[], opts: LayoutOptions): Map<string, Point> {
  const byId = new Map(items.map(i => [i.id, i]));
  const readingOrder = (a: LayoutItem, b: LayoutItem) => a.y - b.y || a.x - b.x;

  // Only links between two different items in the set, once each.
  const seen = new Set<string>();
  const links = edges.filter(e => {
    const key = `${e.from}\u0000${e.to}`;
    if (e.from === e.to || !byId.has(e.from) || !byId.has(e.to) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const linked = new Set(links.flatMap(e => [e.from, e.to]));
  const connected = items.filter(i => linked.has(i.id)).sort(readingOrder);
  const loose = items.filter(i => !linked.has(i.id)).sort(readingOrder);

  const out = new Map<string, Point>();
  let blockHeight = 0;

  if (connected.length) {
    const dag = breakCycles(connected, links);
    const columns = assignColumns(connected, dag);
    orderColumns(columns, dag);

    const heightOf = (col: LayoutItem[]) => col.reduce((h, i) => h + i.height, 0) + opts.gapY * (col.length - 1);
    blockHeight = Math.max(...columns.map(heightOf));

    let x = 0;
    for (const col of columns) {
      let y = (blockHeight - heightOf(col)) / 2;
      for (const item of col) {
        out.set(item.id, { x, y });
        y += item.height + opts.gapY;
      }
      x += Math.max(...col.map(i => i.width)) + opts.gapX;
    }
  }

  if (loose.length) {
    const perRow = Math.max(1, Math.ceil(Math.sqrt(loose.length)));
    const cellW = Math.max(...loose.map(i => i.width)) + opts.gapX;
    const top = connected.length ? blockHeight + opts.gapY * 2 : 0;
    // Rows take the height of their tallest item, so mixed sizes don't overlap.
    let y = top;
    for (let r = 0; r * perRow < loose.length; r++) {
      const row = loose.slice(r * perRow, (r + 1) * perRow);
      row.forEach((item, c) => out.set(item.id, { x: c * cellW, y }));
      y += Math.max(...row.map(i => i.height)) + opts.gapY;
    }
  }

  return out;
}

/** Drops the links that close a loop (found by a depth-first walk in reading order), leaving a DAG. */
function breakCycles(items: LayoutItem[], links: LayoutEdge[]): LayoutEdge[] {
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
  for (const i of items) if (!state.has(i.id)) visit(i.id);
  return kept;
}

/** Each item's column is the length of the longest prereq chain leading to it. */
function assignColumns(items: LayoutItem[], dag: LayoutEdge[]): LayoutItem[][] {
  const indegree = new Map(items.map(i => [i.id, 0]));
  for (const e of dag) indegree.set(e.to, indegree.get(e.to)! + 1);

  const col = new Map(items.map(i => [i.id, 0]));
  const queue = items.filter(i => indegree.get(i.id) === 0).map(i => i.id);
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of dag) {
      if (e.from !== id) continue;
      col.set(e.to, Math.max(col.get(e.to)!, col.get(id)! + 1));
      indegree.set(e.to, indegree.get(e.to)! - 1);
      if (indegree.get(e.to) === 0) queue.push(e.to);
    }
  }

  const columns: LayoutItem[][] = [];
  for (const i of items) (columns[col.get(i.id)!] ??= []).push(i); // items arrive in reading order
  return columns.filter(Boolean);
}

/** Reorders each column so items sit near the average position of what they link to (fewer crossings). */
function orderColumns(columns: LayoutItem[][], dag: LayoutEdge[]): void {
  const neighbours = (id: string, dir: 'prev' | 'next') =>
    dir === 'prev' ? dag.filter(e => e.to === id).map(e => e.from) : dag.filter(e => e.from === id).map(e => e.to);

  const sortBy = (col: LayoutItem[], dir: 'prev' | 'next', index: Map<string, number>) => {
    const score = new Map<string, number>();
    col.forEach((item, i) => {
      const ns = neighbours(item.id, dir).filter(n => index.has(n));
      score.set(item.id, ns.length ? ns.reduce((s, n) => s + index.get(n)!, 0) / ns.length : i);
    });
    col.sort((a, b) => score.get(a.id)! - score.get(b.id)!); // stable, so ties keep their order
  };

  const indexOf = (col: LayoutItem[]) => new Map(col.map((item, i) => [item.id, i]));
  for (let pass = 0; pass < 4; pass++) {
    for (let c = 1; c < columns.length; c++) sortBy(columns[c], 'prev', indexOf(columns[c - 1]));
    for (let c = columns.length - 2; c >= 0; c--) sortBy(columns[c], 'next', indexOf(columns[c + 1]));
  }
}
