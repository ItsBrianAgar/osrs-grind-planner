import { LayoutItem, layeredLayout } from './auto-layout';
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
