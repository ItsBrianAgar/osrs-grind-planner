import { TestBed } from '@angular/core/testing';
import { CanvasService } from './canvas.service';

let canvas: CanvasService;
let setItem: (k: string, v: string) => void;

beforeEach(() => {
  // The test environment has no working localStorage — give each test a fresh in-memory one.
  const store = new Map<string, string>();
  setItem = (k, v) => { store.set(k, v); };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => setItem(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    },
  });
  TestBed.configureTestingModule({});
  canvas = TestBed.inject(CanvasService);
});

describe('CanvasService.spliceIntoConnection', () => {
  it('replaces A → B with A → inserted → B, keeping A and B on their original sides', () => {
    const a = canvas.addNode(0, 0);
    const b = canvas.addNode(0, 400);
    const mid = canvas.addNode(0, 200);
    canvas.addConnection(a, 'node', 'bottom', b, 'node', 'top');
    const connId = canvas.connections()[0].id;

    expect(canvas.spliceIntoConnection(connId, mid, 'node', 'top', 'bottom')).toBe(true);

    const conns = canvas.connections().map(({ id, ...rest }) => rest);
    expect(conns).toEqual([
      { fromId: a, fromKind: 'node', fromSide: 'bottom', toId: mid, toKind: 'node', toSide: 'top' },
      { fromId: mid, fromKind: 'node', fromSide: 'bottom', toId: b, toKind: 'node', toSide: 'top' },
    ]);
  });

  it('splices a whole group in', () => {
    const a = canvas.addNode(0, 0);
    const b = canvas.addNode(0, 600);
    const m1 = canvas.addNode(0, 200);
    const m2 = canvas.addNode(300, 200);
    canvas.groupNodesTogether([m1, m2]);
    const groupId = canvas.getNode(m1)!.groupId!;
    canvas.addConnection(a, 'node', 'bottom', b, 'node', 'top');

    expect(canvas.spliceIntoConnection(canvas.connections()[0].id, groupId, 'group', 'top', 'bottom')).toBe(true);
    expect(canvas.connections().map(c => [c.fromId, c.toId])).toEqual([[a, groupId], [groupId, b]]);
  });

  it('refuses (and changes nothing) when it would loop a node into its own group', () => {
    const a = canvas.addNode(0, 0);
    const b = canvas.addNode(0, 400);
    canvas.groupNodesTogether([a, b]);
    const groupId = canvas.getNode(a)!.groupId!;
    const c = canvas.addNode(0, 800);
    canvas.addConnection(groupId, 'group', 'bottom', c, 'node', 'top');
    const before = canvas.connections();

    expect(canvas.spliceIntoConnection(before[0].id, a, 'node', 'top', 'bottom')).toBe(false);
    expect(canvas.connections()).toBe(before);
  });
});

describe('CanvasService undo/redo', () => {
  it('skips steps where nothing changed — e.g. clicking a node (snapshot for a drag that never moves)', () => {
    canvas.snapshot();
    const a = canvas.addNode(0, 0);
    canvas.snapshot(); // click on the node: drag-start snapshot...
    // ...and the mouse never moved.
    expect(canvas.undo()).toBe(true);
    expect(canvas.getNode(a)).toBeUndefined();
  });

  it("doesn't let a no-op snapshot wipe the redo stack", () => {
    canvas.snapshot();
    canvas.addNode(0, 0);
    canvas.undo();
    canvas.snapshot(); // a click after undoing
    expect(canvas.redo()).toBe(true);
    expect(canvas.nodes()).toHaveLength(1);
  });

  it("doesn't record a step for a rewire rejected as a self-loop", () => {
    const a = canvas.addNode(0, 0);
    const b = canvas.addNode(0, 200);
    canvas.addConnection(a, 'node', 'bottom', b, 'node', 'top');
    const before = canvas.connections();
    canvas.snapshot();
    canvas.updateConnection(before[0].id, { toId: a });
    expect(canvas.connections()).toBe(before);
    expect(canvas.undo()).toBe(false);
  });

  it('drops selected ids whose node an undo removed', () => {
    canvas.snapshot();
    const a = canvas.addNode(0, 0);
    canvas.selectOnly(a);
    canvas.undo();
    expect(canvas.selectedNodeIds().size).toBe(0);
  });
});

describe('CanvasService grouping cleanup', () => {
  it('drops a group name and group connections when grouping-by-drop empties the old group', () => {
    const a = canvas.addNode(0, 0);
    const b = canvas.addNode(300, 0);
    const c = canvas.addNode(600, 0);
    canvas.groupNodesTogether([a, b]);
    const oldGroup = canvas.getNode(a)!.groupId!;
    canvas.setGroupName(oldGroup, 'Old');
    canvas.addConnection(oldGroup, 'group', 'right', c, 'node', 'left');
    canvas.ungroupNode(b); // old group now has only `a`

    canvas.groupNodes(a, c); // drop `a` onto `c` — old group is now empty

    expect(canvas.groupNames()[oldGroup]).toBeUndefined();
    expect(canvas.connections().some(conn => conn.fromId === oldGroup)).toBe(false);
  });
});

describe('CanvasService.importBoards', () => {
  const node = (id: string, extra: object = {}) => ({ id, x: 0, y: 0, title: id, notes: '', completed: false, ...extra });

  it('fills in optional node fields and drops connections to missing endpoints', () => {
    canvas.importBoards({
      version: 1,
      nodes: [{ id: 'a', x: 1, y: 2 }, node('b')],
      connections: [
        { id: 'ok', fromId: 'a', fromSide: 'bottom', toId: 'b', toSide: 'top' }, // legacy: no kinds
        { id: 'dangling', fromId: 'a', fromKind: 'node', fromSide: 'bottom', toId: 'gone', toKind: 'node', toSide: 'top' },
      ],
      groupNames: { stale: 'No such group' },
    }, 'file');
    expect(canvas.getNode('a')).toEqual({ id: 'a', x: 1, y: 2, title: '', notes: '', completed: false });
    expect(canvas.connections().map(c => c.id)).toEqual(['ok']);
    expect(canvas.connections()[0].fromKind).toBe('node');
    expect(canvas.groupNames()).toEqual({});
  });

  it.each([
    ['not an object', 'nope'],
    ['no nodes array', { connections: [] }],
    ['a node with no id', { nodes: [{ x: 0, y: 0 }], connections: [] }],
    ['a node with no position', { nodes: [{ id: 'a' }], connections: [] }],
    ['duplicate node ids', { nodes: [node('a'), node('a')], connections: [] }],
    ['a malformed connection', { nodes: [node('a'), node('b')], connections: [{ id: 'c', fromId: 'a', toId: 'b', fromSide: 'up', toSide: 'top' }] }],
    ['a bundle with one bad board', { boards: [{ nodes: [node('a')], connections: [] }, { nodes: [{ id: 'b' }], connections: [] }] }],
  ])('rejects %s, adding nothing', (_, data) => {
    const a = canvas.addNode(0, 0);
    expect(() => canvas.importBoards(data, 'file')).toThrow(/doesn't look like a grind planner export/);
    expect(canvas.boards().length).toBe(1);
    expect(canvas.nodes().map(n => n.id)).toEqual([a]);
  });

  it('adds a single-board file as a new board and opens it, leaving the current board alone', () => {
    const a = canvas.addNode(0, 0);
    const original = canvas.activeBoardId();
    canvas.selectOnly(a);
    const [added] = canvas.importBoards({ nodes: [node('x')], connections: [] }, 'my-export');

    expect(canvas.boards().map(b => b.name)).toEqual(['My board', 'my-export']);
    expect(canvas.activeBoardId()).toBe(added.id);
    expect(canvas.nodes().map(n => n.id)).toEqual(['x']);
    expect(canvas.selectedNodeIds().size).toBe(0);

    canvas.switchBoard(original);
    expect(canvas.nodes().map(n => n.id)).toEqual([a]);
  });

  it('round-trips every board through exportAllBoards', () => {
    canvas.renameBoard(canvas.activeBoardId(), 'Ironman');
    canvas.addNode(0, 0);
    canvas.createBoard('Quests');
    canvas.addNode(0, 0);
    canvas.addNode(10, 10);

    const added = canvas.importBoards(JSON.parse(JSON.stringify(canvas.exportAllBoards())), 'file');
    expect(added.map(b => b.name)).toEqual(['Ironman', 'Quests']);
    expect(canvas.activeBoardId()).toBe(added[0].id);
    expect(canvas.nodes().length).toBe(1);
    canvas.switchBoard(added[1].id);
    expect(canvas.nodes().length).toBe(2);
  });
});

describe('CanvasService copy/paste', () => {
  it('pastes onto another board with fresh ids, keeping connections and multi-node groups', () => {
    const a = canvas.addNode(0, 0);
    const b = canvas.addNode(300, 0);
    const lone = canvas.addNode(600, 0);
    const other = canvas.addNode(900, 0);
    canvas.groupNodesTogether([a, b]);
    canvas.groupNodesTogether([lone, other]);
    canvas.setGroupName(canvas.getNode(a)!.groupId!, 'Pair');
    canvas.addConnection(a, 'node', 'right', b, 'node', 'left');
    canvas.addConnection(b, 'node', 'right', lone, 'node', 'left');
    canvas.addConnection(canvas.getNode(a)!.groupId!, 'group', 'bottom', lone, 'node', 'top');
    canvas.addConnection(a, 'node', 'bottom', canvas.getNode(lone)!.groupId!, 'group', 'top'); // group not copied

    expect(canvas.copyNodes([a, b, lone])).toBe(3);
    canvas.createBoard();
    const pasted = canvas.pasteNodes(1000, 1000);

    expect(pasted.length).toBe(3);
    expect(pasted).not.toContain(a);
    expect(new Set(canvas.selectedNodeIds())).toEqual(new Set(pasted));
    const [pa, pb, pl] = pasted.map(id => canvas.getNode(id)!);
    expect(pa.groupId).toBeDefined();
    expect(pa.groupId).toBe(pb.groupId);
    expect(pl.groupId).toBeUndefined(); // lone member of a group pastes ungrouped
    expect(canvas.getGroupName(pa.groupId!)).toBe('Pair');
    expect(pb.x - pa.x).toBe(300); // layout kept
    expect(canvas.connections().length).toBe(3); // the connection to the uncopied group is dropped
    expect(canvas.connections().every(c => [...pasted, pa.groupId].includes(c.fromId) && [...pasted, pa.groupId].includes(c.toId))).toBe(true);
  });

  it('duplicates a group beside itself, with its name and inner connections, leaving the clipboard alone', () => {
    const a = canvas.addNode(0, 0);
    const b = canvas.addNode(0, 200);
    canvas.groupNodesTogether([a, b]);
    const group = canvas.getNode(a)!.groupId!;
    canvas.setGroupName(group, 'Slayer');
    canvas.addConnection(a, 'node', 'bottom', b, 'node', 'top');

    const copies = canvas.duplicateGroup(group).map(id => canvas.getNode(id)!);
    expect(copies.length).toBe(2);
    expect(copies[0].groupId).not.toBe(group);
    expect(copies[0].groupId).toBe(copies[1].groupId);
    expect(canvas.getGroupName(copies[0].groupId!)).toBe('Slayer');
    expect(copies[0].x).toBeGreaterThan(240); // beside the original, not on top of it
    expect(canvas.connections().length).toBe(2);
    expect(canvas.clipboardSize()).toBe(0);
  });

  it('round-trips the clipboard as text, for pasting into another tab or copy of the app', () => {
    const a = canvas.addNode(0, 0);
    const b = canvas.addNode(300, 0);
    canvas.groupNodesTogether([a, b]);
    canvas.addConnection(a, 'node', 'right', b, 'node', 'left');
    canvas.copyNodes([a, b]);
    const text = canvas.clipboardText()!;

    // A fresh app instance (the other site) starts with an empty clipboard.
    TestBed.resetTestingModule();
    localStorage.clear();
    const other = TestBed.inject(CanvasService);
    expect(other.clipboardSize()).toBe(0);
    expect(other.loadClipboardText(text)).toBe(2);
    const pasted = other.pasteNodes(0, 0).map(id => other.getNode(id)!);
    expect(pasted.length).toBe(2);
    expect(pasted[0].groupId).toBe(pasted[1].groupId);
    expect(other.connections().length).toBe(1);
  });

  it('ignores clipboard text that isn\'t copied nodes', () => {
    canvas.copyNodes([canvas.addNode(0, 0)]);
    expect(canvas.loadClipboardText('hello')).toBe(0);
    expect(canvas.loadClipboardText('{"nodes":[],"connections":[]}')).toBe(0);
    expect(canvas.loadClipboardText(JSON.stringify({ osrsGrindPlannerClipboard: 1, nodes: [{}], connections: [] }))).toBe(0);
    expect(canvas.clipboardSize()).toBe(1); // left as it was
  });

  it('pastes nothing before anything is copied', () => {
    expect(canvas.pasteNodes(0, 0)).toEqual([]);
    expect(canvas.copyNodes([])).toBe(0);
  });
});

describe('CanvasService boards', () => {
  it('keeps each board\'s canvas and undo history separate', () => {
    const first = canvas.activeBoardId();
    canvas.snapshot();
    const a = canvas.addNode(0, 0);

    const second = canvas.createBoard();
    expect(canvas.nodes()).toEqual([]);
    expect(canvas.undo()).toBe(false); // the first board's history doesn't leak in

    canvas.switchBoard(first);
    expect(canvas.nodes().map(n => n.id)).toEqual([a]);
    expect(canvas.undo()).toBe(true);
    expect(canvas.nodes()).toEqual([]);
    expect(second).not.toBe(first);
  });

  it('migrates the pre-boards canvas into a first board', () => {
    localStorage.setItem('osrs-canvas-nodes', JSON.stringify([{ id: 'old', x: 0, y: 0, title: 'Old', notes: '', completed: false }]));
    localStorage.removeItem('osrs-boards');
    TestBed.resetTestingModule();
    const migrated = TestBed.inject(CanvasService);

    expect(migrated.boards().map(b => b.name)).toEqual(['My board']);
    expect(migrated.nodes().map(n => n.id)).toEqual(['old']);
    expect(localStorage.getItem('osrs-canvas-nodes')).toBeNull();
  });

  it('restores the open board from storage on reload', () => {
    canvas.createBoard('Second');
    const id = canvas.addNode(0, 0);
    window.dispatchEvent(new Event('pagehide'));
    TestBed.flushEffects();

    TestBed.resetTestingModule();
    const reloaded = TestBed.inject(CanvasService);
    expect(reloaded.activeBoard().name).toBe('Second');
    expect(reloaded.nodes().map(n => n.id)).toEqual([id]);
  });

  it('duplicates a board right after the original', () => {
    canvas.renameBoard(canvas.activeBoardId(), 'Main');
    canvas.addNode(0, 0);
    canvas.createBoard('Other');
    canvas.duplicateBoard(canvas.boards()[0].id);

    expect(canvas.boards().map(b => b.name)).toEqual(['Main', 'Main copy', 'Other']);
    expect(canvas.activeBoard().name).toBe('Main copy');
    expect(canvas.nodes().length).toBe(1);
  });

  it('deletes a board, opens its neighbour, and can put it back', () => {
    const first = canvas.activeBoardId();
    canvas.createBoard('Doomed');
    const node = canvas.addNode(0, 0);
    const doomed = canvas.activeBoardId();

    const undo = canvas.deleteBoard(doomed)!;
    expect(canvas.boards().map(b => b.id)).toEqual([first]);
    expect(canvas.activeBoardId()).toBe(first);
    expect(localStorage.getItem(`osrs-board-${doomed}`)).toBeNull();

    undo();
    expect(canvas.boards().map(b => b.name)).toEqual(['My board', 'Doomed']);
    expect(canvas.activeBoardId()).toBe(doomed);
    expect(canvas.nodes().map(n => n.id)).toEqual([node]);
  });

  it('reorders boards', () => {
    canvas.renameBoard(canvas.activeBoardId(), 'A');
    canvas.createBoard('B');
    canvas.createBoard('C');
    canvas.moveBoard(2, 0);
    expect(canvas.boards().map(b => b.name)).toEqual(['C', 'A', 'B']);
    canvas.moveBoard(0, 5); // out of range: ignored
    expect(canvas.boards().map(b => b.name)).toEqual(['C', 'A', 'B']);
  });

  it('won\'t delete the last board', () => {
    expect(canvas.deleteBoard(canvas.activeBoardId())).toBeNull();
    expect(canvas.boards().length).toBe(1);
  });

  it('ignores a blank rename', () => {
    const id = canvas.activeBoardId();
    canvas.renameBoard(id, '   ');
    expect(canvas.activeBoard().name).toBe('My board');
  });
});

describe('CanvasService saving', () => {
  it('reports a full-storage failure instead of failing silently, and clears it once a save works', () => {
    setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
    window.dispatchEvent(new Event('pagehide')); // flushes immediately
    expect(canvas.saveError()).toMatch(/storage is full/);

    setItem = () => {};
    window.dispatchEvent(new Event('pagehide'));
    expect(canvas.saveError()).toBeNull();
  });
});
