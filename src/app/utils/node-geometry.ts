import { NodeSide } from '../models/grind-node.model';

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Anything with a top-left world position — a node or a group's bounding box both qualify. */
export interface Box {
  x: number;
  y: number;
}

/** Outward-facing unit vector for each side — used both to locate a port and to aim a curve's control point. */
export const SIDE_NORMALS: Record<NodeSide, Point> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/** World-space midpoint of the given side of a box (a node's rendered card, or a group's bounding rectangle). */
export function sidePoint(box: Box, side: NodeSide, size: Size): Point {
  switch (side) {
    case 'top': return { x: box.x + size.width / 2, y: box.y };
    case 'bottom': return { x: box.x + size.width / 2, y: box.y + size.height };
    case 'left': return { x: box.x, y: box.y + size.height / 2 };
    case 'right': return { x: box.x + size.width, y: box.y + size.height / 2 };
  }
}

export const OPPOSITE_SIDE: Record<NodeSide, NodeSide> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

/**
 * The side of a box that faces toward a point outside it — distances are measured in units of
 * the box's half-size so a wide card doesn't get biased toward its left/right edges.
 */
export function sideFacing(box: Box, size: Size, target: Point): NodeSide {
  const dx = (target.x - (box.x + size.width / 2)) / (size.width / 2);
  const dy = (target.y - (box.y + size.height / 2)) / (size.height / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'bottom' : 'top';
}

/** Control points for a connection curve: each pulls outward along its side's normal, so the curve always leaves/arrives perpendicular to the box edge. An end with no fixed side (the cursor) just trails toward the other point. */
function bezierControls(p1: Point, side1: NodeSide, p2: Point, side2: NodeSide | null): [Point, Point] {
  const dist = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y));
  const offset = Math.max(50, dist * 0.4);
  const n1 = SIDE_NORMALS[side1];
  const c1 = { x: p1.x + n1.x * offset, y: p1.y + n1.y * offset };
  if (!side2) return [c1, p2];
  const n2 = SIDE_NORMALS[side2];
  return [c1, { x: p2.x + n2.x * offset, y: p2.y + n2.y * offset }];
}

/** SVG path data for a connection curve between two side points. */
export function bezierPath(p1: Point, side1: NodeSide, p2: Point, side2: NodeSide | null): string {
  const [c1, c2] = bezierControls(p1, side1, p2, side2);
  return `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`;
}

/** `steps + 1` evenly spaced (in t) points along the same curve bezierPath draws — for hit-testing it. */
export function sampleBezier(p1: Point, side1: NodeSide, p2: Point, side2: NodeSide | null, steps: number): Point[] {
  const [c1, c2] = bezierControls(p1, side1, p2, side2);
  const points: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    points.push({
      x: a * p1.x + b * c1.x + c * c2.x + d * p2.x,
      y: a * p1.y + b * c1.y + c * c2.y + d * p2.y,
    });
  }
  return points;
}

/** Shortest distance from a point to a polyline (e.g. a sampled curve), measured to its segments, not just its vertices. */
export function distanceToPolyline(points: Point[], p: Point): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

function insideBox(p: Point, box: Box, size: Size): boolean {
  return p.x >= box.x && p.x <= box.x + size.width && p.y >= box.y && p.y <= box.y + size.height;
}

/**
 * Which edge of a box the segment from `outside` to `inside` crosses. A point beyond a corner
 * violates two bounds; the edge actually crossed is whichever bound the segment reaches last.
 */
function crossedEdge(outside: Point, inside: Point, box: Box, size: Size): NodeSide {
  const candidates: [NodeSide, number][] = [];
  const dx = inside.x - outside.x;
  const dy = inside.y - outside.y;
  if (outside.x < box.x) candidates.push(['left', (box.x - outside.x) / dx]);
  if (outside.x > box.x + size.width) candidates.push(['right', (box.x + size.width - outside.x) / dx]);
  if (outside.y < box.y) candidates.push(['top', (box.y - outside.y) / dy]);
  if (outside.y > box.y + size.height) candidates.push(['bottom', (box.y + size.height - outside.y) / dy]);
  return candidates.reduce((best, c) => (c[1] > best[1] ? c : best))[0];
}

/**
 * The edges a sampled curve enters and leaves a box through, following the curve's direction.
 * Either is null when the curve starts/ends inside the box (so it never crosses in/out), and
 * both are null when the curve misses the box entirely.
 */
export function curveCrossings(points: Point[], box: Box, size: Size): { entry: NodeSide | null; exit: NodeSide | null } {
  const first = points.findIndex(p => insideBox(p, box, size));
  if (first === -1) return { entry: null, exit: null };
  const last = points.length - 1 - [...points].reverse().findIndex(p => insideBox(p, box, size));
  return {
    entry: first > 0 ? crossedEdge(points[first - 1], points[first], box, size) : null,
    exit: last < points.length - 1 ? crossedEdge(points[last + 1], points[last], box, size) : null,
  };
}

/**
 * Whichever side of a box the given point (assumed inside or on the box, e.g. the cursor at
 * drop time) is closest to — lets the user pick the exact attaching side by where they
 * drag/drop, rather than it being auto-picked from relative node positions.
 */
export function nearestSide(box: Box, size: Size, px: number, py: number): NodeSide {
  const distLeft = px - box.x;
  const distRight = (box.x + size.width) - px;
  const distTop = py - box.y;
  const distBottom = (box.y + size.height) - py;

  const min = Math.min(distLeft, distRight, distTop, distBottom);
  if (min === distTop) return 'top';
  if (min === distBottom) return 'bottom';
  if (min === distLeft) return 'left';
  return 'right';
}
