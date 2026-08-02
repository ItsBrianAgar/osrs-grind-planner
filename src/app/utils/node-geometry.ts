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
