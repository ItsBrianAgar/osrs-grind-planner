import { LayoutItem, canSwap, layeredLayout, perRowForWidth, placeLayout, planLayout, swapInPlan } from './auto-layout';
import { facingSides } from './node-geometry';

const item = (id: string, x = 0, y = 0, width = 240, height = 120): LayoutItem => ({ id, x, y, width, height });
const GAP = { gapX: 80, gapY: 40 };

describe('layeredLayout', () => {
  it('puts a prereq chain in successive columns, left to right', () => {
    const pos = layeredLayout([item('c'), item('a'), item('b')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }], GAP);
    expect(pos.get('a')).toEqual({ x: 0, y: 0 });
    expect(pos.get('b')).toEqual({ x: 320, y: 0 });
    expect(pos.get('c')).toEqual({ x: 640, y: 0 });
  });

  it('places an item after the longest chain leading to it', () => {
    // a → b → d and a → d: d still goes after b.
    const pos = layeredLayout([item('a'), item('b'), item('d')], [
      { from: 'a', to: 'b' }, { from: 'b', to: 'd' }, { from: 'a', to: 'd' },
    ], GAP);
    expect(pos.get('d')!.x).toBe(640);
  });

  it('stacks a column and centres shorter columns against it', () => {
    const pos = layeredLayout([item('a'), item('b', 0, 0), item('c', 0, 500)], [
      { from: 'a', to: 'b' }, { from: 'a', to: 'c' },
    ], GAP);
    expect(pos.get('b')).toEqual({ x: 320, y: 0 });
    expect(pos.get('c')).toEqual({ x: 320, y: 160 });
    expect(pos.get('a')).toEqual({ x: 0, y: 80 }); // centred against the 280px column
  });

  it('keeps the current top-to-bottom order of unrelated items in a column', () => {
    const pos = layeredLayout([item('low', 0, 900), item('high', 0, 100), item('x', 400, 0)], [
      { from: 'high', to: 'x' }, { from: 'low', to: 'x' },
    ], GAP);
    expect(pos.get('high')).toEqual({ x: 0, y: 0 });
    expect(pos.get('low')).toEqual({ x: 0, y: 160 });
  });

  it('packs unlinked items in a grid below the linked ones', () => {
    const pos = layeredLayout([item('a'), item('b'), item('l1', 0, 1), item('l2', 0, 2)], [{ from: 'a', to: 'b' }], GAP);
    expect(pos.get('l1')).toEqual({ x: 0, y: 200 });
    expect(pos.get('l2')).toEqual({ x: 320, y: 200 });
  });

  it('still lays out a loop, without hanging', () => {
    const pos = layeredLayout([item('a'), item('b', 0, 10)], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }], GAP);
    expect(pos.get('a')).toEqual({ x: 0, y: 0 });
    expect(pos.get('b')).toEqual({ x: 320, y: 0 });
  });

  it('orders a column to follow its prereqs, avoiding crossings', () => {
    // a above b, but a's dependent is currently below b's.
    const pos = layeredLayout(
      [item('a', 0, 0), item('b', 0, 200), item('fromB', 400, 0), item('fromA', 400, 200)],
      [{ from: 'a', to: 'fromA' }, { from: 'b', to: 'fromB' }],
      GAP,
    );
    expect(pos.get('fromA')!.y).toBeLessThan(pos.get('fromB')!.y);
  });
});

describe('placeLayout', () => {
  const sizes = new Map(['a', 'b', 'c', 'l1', 'l2'].map(id => [id, { width: 240, height: 120 }]));

  it('reports a gap between columns and between stacked items, sized by the options', () => {
    const p = placeLayout({ columns: [['a'], ['b', 'c']], loose: [] }, sizes, { gapX: 100, gapY: 20 });
    expect(p.gaps).toContainEqual({ axis: 'x', x: 240, y: 0, width: 100, height: 260 });
    expect(p.gaps).toContainEqual({ axis: 'y', x: 340, y: 120, width: 240, height: 20 });
    expect(p.width).toBe(580);
    expect(p.height).toBe(260);
  });

  it('re-spaces the same plan with new gaps', () => {
    const plan = { columns: [['a'], ['b']], loose: [] };
    expect(placeLayout(plan, sizes, { gapX: 10, gapY: 0 }).positions.get('b')).toEqual({ x: 250, y: 0 });
    expect(placeLayout(plan, sizes, { gapX: 200, gapY: 0 }).positions.get('b')).toEqual({ x: 440, y: 0 });
  });

  it('reports gaps between grid cells', () => {
    const p = placeLayout({ columns: [], loose: ['l1', 'l2'] }, sizes, { gapX: 50, gapY: 20 });
    expect(p.gaps).toEqual([{ axis: 'x', x: 240, y: 0, width: 50, height: 120 }]);
  });
});

describe('grid items per row', () => {
  const ids = ['l1', 'l2', 'l3', 'l4'];
  const sizes = new Map(ids.map(id => [id, { width: 100, height: 50 }]));
  const opts = { gapX: 20, gapY: 10 };

  it('uses the plan\'s perRow, clamped to the item count', () => {
    expect(placeLayout({ columns: [], loose: ids, perRow: 4 }, sizes, opts).positions.get('l4')).toEqual({ x: 360, y: 0 });
    expect(placeLayout({ columns: [], loose: ids, perRow: 1 }, sizes, opts).positions.get('l4')).toEqual({ x: 0, y: 180 });
    expect(placeLayout({ columns: [], loose: ids, perRow: 9 }, sizes, opts).grid!.perRow).toBe(4);
  });

  it('fits as many per row as the dragged edge wholly encloses', () => {
    const grid = placeLayout({ columns: [], loose: ids, perRow: 2 }, sizes, opts).grid!;
    expect(perRowForWidth(grid, 100, 20)).toBe(1);
    expect(perRowForWidth(grid, 340, 20)).toBe(3); // exactly 3 cells wide
    expect(perRowForWidth(grid, 339, 20)).toBe(2); // edge just inside the third
    expect(perRowForWidth(grid, 5000, 20)).toBe(4);
    expect(perRowForWidth(grid, -50, 20)).toBe(1);
  });

  it('gives the same answer whatever the current count, so it can\'t flip-flop', () => {
    for (const perRow of [1, 2, 3, 4]) {
      const grid = placeLayout({ columns: [], loose: ids, perRow }, sizes, opts).grid!;
      expect(perRowForWidth(grid, 339, 20)).toBe(2);
    }
  });
});

describe('reordering', () => {
  const plan = { columns: [['a'], ['b', 'c']], loose: ['l1', 'l2'] };

  it('only swaps within a column, or within the grid', () => {
    expect(canSwap(plan, 'b', 'c')).toBe(true);
    expect(canSwap(plan, 'l1', 'l2')).toBe(true);
    expect(canSwap(plan, 'a', 'b')).toBe(false);
    expect(canSwap(plan, 'c', 'l1')).toBe(false);
  });

  it('swaps two places without touching the original', () => {
    expect(swapInPlan(plan, 'b', 'c')).toEqual({ columns: [['a'], ['c', 'b']], loose: ['l1', 'l2'] });
    expect(plan.columns[1]).toEqual(['b', 'c']);
  });

  it('plans the same columns layeredLayout places', () => {
    expect(planLayout([item('a'), item('b')], [{ from: 'a', to: 'b' }])).toEqual({ columns: [['a'], ['b']], loose: [] });
  });
});

describe('facingSides', () => {
  const size = { width: 240, height: 120 };

  it('runs right → left when the target is clear to the right, and the reverse to the left', () => {
    expect(facingSides({ x: 0, y: 0 }, size, { x: 300, y: 400 }, size)).toEqual({ fromSide: 'right', toSide: 'left' });
    expect(facingSides({ x: 300, y: 0 }, size, { x: 0, y: 0 }, size)).toEqual({ fromSide: 'left', toSide: 'right' });
  });

  it('runs vertically when the boxes overlap horizontally', () => {
    expect(facingSides({ x: 0, y: 0 }, size, { x: 100, y: 300 }, size)).toEqual({ fromSide: 'bottom', toSide: 'top' });
    expect(facingSides({ x: 0, y: 300 }, size, { x: 100, y: 0 }, size)).toEqual({ fromSide: 'top', toSide: 'bottom' });
  });
});
