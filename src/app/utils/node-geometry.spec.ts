import { curveCrossings, distanceToPolyline, sampleBezier, sideFacing } from './node-geometry';

describe('sideFacing', () => {
  const box = { x: 0, y: 0 };
  const size = { width: 240, height: 60 };

  it('picks the side toward a point above/below/left/right', () => {
    expect(sideFacing(box, size, { x: 120, y: -200 })).toBe('top');
    expect(sideFacing(box, size, { x: 120, y: 300 })).toBe('bottom');
    expect(sideFacing(box, size, { x: -300, y: 30 })).toBe('left');
    expect(sideFacing(box, size, { x: 600, y: 30 })).toBe('right');
  });

  it("normalizes by the box's half-size so a wide card isn't biased toward left/right", () => {
    // 150px right but 100px up: raw distance favors right, but relative to a 240×60 card it's well above.
    expect(sideFacing(box, size, { x: 270, y: -100 })).toBe('top');
  });
});

describe('curveCrossings', () => {
  const box = { x: 400, y: 200 };
  const size = { width: 240, height: 120 };

  it('reports left → right for a wire running horizontally through the box, even from ends above and below', () => {
    // Mirrors the real case: source exits a group's bottom above-left, target is a group's top below-right,
    // but the curve itself sweeps sideways across the card.
    const pts = [{ x: 0, y: 0 }, { x: 300, y: 260 }, { x: 500, y: 255 }, { x: 700, y: 250 }, { x: 900, y: 600 }];
    expect(curveCrossings(pts, box, size)).toEqual({ entry: 'left', exit: 'right' });
  });

  it('reports top → bottom for a vertical wire', () => {
    const pts = [{ x: 500, y: 0 }, { x: 500, y: 250 }, { x: 500, y: 500 }];
    expect(curveCrossings(pts, box, size)).toEqual({ entry: 'top', exit: 'bottom' });
  });

  it('resolves a diagonal step past a corner to the edge actually crossed', () => {
    // From above-left, the segment hits y=200 (top) at t≈0.33 but x=400 (left) only at t=0.8 — so it enters via the left.
    const pts = [{ x: 0, y: 150 }, { x: 500, y: 300 }];
    expect(curveCrossings(pts, box, size).entry).toBe('left');
  });

  it('returns nulls when the curve misses, or starts inside', () => {
    expect(curveCrossings([{ x: 0, y: 0 }, { x: 10, y: 10 }], box, size)).toEqual({ entry: null, exit: null });
    expect(curveCrossings([{ x: 500, y: 250 }, { x: 900, y: 250 }], box, size)).toEqual({ entry: null, exit: 'right' });
  });
});

describe('sampleBezier', () => {
  it('starts and ends on the endpoints', () => {
    const pts = sampleBezier({ x: 0, y: 0 }, 'bottom', { x: 0, y: 400 }, 'top', 10);
    expect(pts).toHaveLength(11);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[10]).toEqual({ x: 0, y: 400 });
  });
});

describe('distanceToPolyline', () => {
  const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];

  it('measures to the nearest segment, not just the nearest vertex', () => {
    expect(distanceToPolyline(line, { x: 50, y: 20 })).toBe(20);
    expect(distanceToPolyline(line, { x: 130, y: 50 })).toBe(30);
  });

  it('measures past an end to that endpoint', () => {
    expect(distanceToPolyline(line, { x: -30, y: -40 })).toBe(50);
  });
});
