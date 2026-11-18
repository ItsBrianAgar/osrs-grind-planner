import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { GrindNode, NodeSide, NODE_WIDTH, NODE_HEIGHT } from '../models/grind-node.model';
import { EndpointKind, NodeConnection } from '../models/connection.model';
import { SettingsService } from './settings.service';

/** Pre-boards storage: the single canvas lived in these three keys. Read once, to migrate them
 *  into the first board, then removed. */
const LEGACY_NODES_KEY = 'osrs-canvas-nodes';
const LEGACY_CONNECTIONS_KEY = 'osrs-canvas-connections';
const LEGACY_GROUP_NAMES_KEY = 'osrs-canvas-group-names';

/** The board list (names, order, saved views) and which board is open. */
const BOARDS_KEY = 'osrs-boards';
/** Each board's canvas is stored under its own key, so saving one board never rewrites the others. */
const boardDataKey = (id: string) => `osrs-board-${id}`;

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Backfills fromKind/toKind for connections saved before group-attached connections existed. */
type LegacyNodeConnection = Omit<NodeConnection, 'fromKind' | 'toKind'> & Partial<Pick<NodeConnection, 'fromKind' | 'toKind'>>;

function normalizeConnection(c: LegacyNodeConnection): NodeConnection {
  return { fromKind: 'node', toKind: 'node', ...c };
}

interface CanvasSnapshot {
  nodes: GrindNode[];
  connections: NodeConnection[];
  groupNames: Record<string, string>;
}

/** Tags copied nodes on the system clipboard, so pasting ignores any other text. */
const CLIPBOARD_MARKER = 'osrsGrindPlannerClipboard';

const EMPTY_SNAPSHOT: CanvasSnapshot = { nodes: [], connections: [], groupNames: {} };

/** Shape written by exportSnapshot() and read back by importBoards() — a versioned copy of
 *  CanvasSnapshot so a future format change can branch on `version` instead of guessing.
 *  `name` is the board's name; files exported before boards existed don't have one. */
export interface CanvasExport {
  version: 1;
  name?: string;
  nodes: GrindNode[];
  connections: NodeConnection[];
  groupNames: Record<string, string>;
}

/** Shape written by exportAllBoards() — every board, each in the single-board format. */
export interface CanvasBundleExport {
  version: 1;
  boards: CanvasExport[];
}

/** Pan/zoom a board was last left at, so switching back to it returns to the same spot. */
export interface BoardView {
  panX: number;
  panY: number;
  zoom: number;
}

export interface BoardMeta {
  id: string;
  name: string;
  view?: BoardView;
}

interface BoardIndex {
  activeId: string;
  boards: BoardMeta[];
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

function readBoardData(id: string): CanvasSnapshot {
  const raw = loadFromStorage<Partial<CanvasSnapshot>>(boardDataKey(id), {});
  return {
    nodes: raw.nodes ?? [],
    connections: (raw.connections ?? []).map(normalizeConnection),
    groupNames: raw.groupNames ?? {},
  };
}

/**
 * Reads the board list and the open board's canvas. On the first run after boards were added,
 * there's no board list yet: the old single canvas becomes the first board. The old keys are only
 * removed once the copy is safely written, so a failed write (storage full) just means the
 * migration runs again next load instead of losing the canvas.
 */
function loadInitialState(): { index: BoardIndex; data: CanvasSnapshot } {
  const stored = loadFromStorage<BoardIndex | null>(BOARDS_KEY, null);
  if (stored && Array.isArray(stored.boards) && stored.boards.length > 0) {
    const activeId = stored.boards.some(b => b.id === stored.activeId) ? stored.activeId : stored.boards[0].id;
    return { index: { activeId, boards: stored.boards }, data: readBoardData(activeId) };
  }

  const id = crypto.randomUUID();
  const index: BoardIndex = { activeId: id, boards: [{ id, name: 'My board' }] };
  const data: CanvasSnapshot = {
    nodes: loadFromStorage(LEGACY_NODES_KEY, []),
    connections: loadFromStorage<LegacyNodeConnection[]>(LEGACY_CONNECTIONS_KEY, []).map(normalizeConnection),
    groupNames: loadFromStorage(LEGACY_GROUP_NAMES_KEY, {}),
  };
  try {
    writeJson(boardDataKey(id), data);
    writeJson(BOARDS_KEY, index);
    for (const key of [LEGACY_NODES_KEY, LEGACY_CONNECTIONS_KEY, LEGACY_GROUP_NAMES_KEY]) localStorage.removeItem(key);
  } catch {
    // Left in place; the normal save path will report the failure.
  }
  return { index, data };
}

const SIDES: readonly NodeSide[] = ['top', 'right', 'bottom', 'left'];
const KINDS: readonly EndpointKind[] = ['node', 'group'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Checks an imported file field by field and normalizes it into a CanvasExport, so a hand-edited
 * or foreign file can't load nodes with no id/position or connections the renderer can't draw.
 * Optional fields get their defaults; connections pointing at an endpoint that doesn't exist are
 * dropped rather than failing the whole import. Throws (with a message fit for the user) on
 * anything structurally wrong.
 */
function parseCanvasExport(data: unknown): CanvasExport {
  const fail = (why: string): never => { throw new Error(`That file doesn't look like a grind planner export (${why}).`); };
  if (!isRecord(data) || !Array.isArray(data['nodes']) || !Array.isArray(data['connections'])) fail('missing nodes or connections');
  const d = data as Record<string, unknown[]>;

  const nodes: GrindNode[] = d['nodes'].map((raw, i) => {
    if (!isRecord(raw)) return fail(`node ${i + 1} isn't an object`);
    const { id, x, y, title, notes, avatarUrl, groupId, completed } = raw;
    if (typeof id !== 'string' || !id) fail(`node ${i + 1} has no id`);
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) fail(`node ${i + 1} has no position`);
    return {
      id: id as string,
      x: x as number,
      y: y as number,
      title: typeof title === 'string' ? title : '',
      notes: typeof notes === 'string' ? notes : '',
      completed: completed === true,
      ...(typeof avatarUrl === 'string' && avatarUrl ? { avatarUrl } : {}),
      ...(typeof groupId === 'string' && groupId ? { groupId } : {}),
    };
  });
  if (new Set(nodes.map(n => n.id)).size !== nodes.length) fail('duplicate node ids');

  const nodeIds = new Set(nodes.map(n => n.id));
  const groupIds = new Set(nodes.map(n => n.groupId).filter((g): g is string => !!g));
  const endpointExists = (id: string, kind: EndpointKind) => (kind === 'node' ? nodeIds : groupIds).has(id);

  const connections: NodeConnection[] = [];
  for (const [i, raw] of d['connections'].entries()) {
    if (!isRecord(raw)) fail(`connection ${i + 1} isn't an object`);
    const c = normalizeConnection(raw as unknown as LegacyNodeConnection);
    const valid =
      typeof c.id === 'string' && typeof c.fromId === 'string' && typeof c.toId === 'string' &&
      KINDS.includes(c.fromKind) && KINDS.includes(c.toKind) &&
      SIDES.includes(c.fromSide) && SIDES.includes(c.toSide);
    if (!valid) fail(`connection ${i + 1} is malformed`);
    if (endpointExists(c.fromId, c.fromKind) && endpointExists(c.toId, c.toKind)) {
      connections.push({ id: c.id, fromId: c.fromId, fromKind: c.fromKind, fromSide: c.fromSide, toId: c.toId, toKind: c.toKind, toSide: c.toSide });
    }
  }

  const groupNames: Record<string, string> = {};
  const rawNames = (data as Record<string, unknown>)['groupNames'];
  if (isRecord(rawNames)) {
    for (const [id, name] of Object.entries(rawNames)) {
      if (typeof name === 'string' && groupIds.has(id)) groupNames[id] = name;
    }
  }

  const name = (data as Record<string, unknown>)['name'];
  return {
    version: 1,
    ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}),
    nodes, connections, groupNames,
  };
}

/** Accepts either export format — one board, or a bundle of every board — and returns the boards
 *  in it. Validates everything before returning, so a bad board anywhere fails the whole import. */
function parseImport(data: unknown): CanvasExport[] {
  if (!isRecord(data) || !Array.isArray(data['boards'])) return [parseCanvasExport(data)];
  const boards = data['boards'];
  if (boards.length === 0) throw new Error('That file doesn\'t contain any boards.');
  return boards.map((b, i) => {
    try {
      return parseCanvasExport(b);
    } catch (err) {
      throw new Error(`Board ${i + 1}: ${err instanceof Error ? err.message : 'unreadable'}`);
    }
  });
}

/** Same state, by reference — every array/object here is replaced on change, never mutated. */
function sameSnapshot(a: CanvasSnapshot, b: CanvasSnapshot): boolean {
  return a.nodes === b.nodes && a.connections === b.connections && a.groupNames === b.groupNames;
}

@Injectable({ providedIn: 'root' })
export class CanvasService {
  private readonly settings = inject(SettingsService);
  private readonly initial = loadInitialState();

  // ── Boards ───────────────────────────────────────────────────────────────
  // Only the open board's canvas lives in the nodes/connections/groupNames signals below; the
  // rest stay in storage (and in boardCache once visited) until they're switched to.

  readonly boards = signal<BoardMeta[]>(this.initial.index.boards);
  readonly activeBoardId = signal<string>(this.initial.index.activeId);
  readonly activeBoard = computed(() =>
    this.boards().find(b => b.id === this.activeBoardId()) ?? this.boards()[0]
  );

  readonly nodes = signal<GrindNode[]>(this.initial.data.nodes);
  readonly connections = signal<NodeConnection[]>(this.initial.data.connections);
  readonly selectedNodeIds = signal<ReadonlySet<string>>(new Set());
  /** Custom group display names, keyed by group id — groups otherwise just show "Group". */
  readonly groupNames = signal<Record<string, string>>(this.initial.data.groupNames);
  /** Set when the last save to localStorage failed (almost always: storage quota is full), so the
   *  UI can warn — otherwise edits would silently stop persisting. Cleared on the next good save. */
  readonly saveError = signal<string | null>(null);

  /** Canvases of boards switched away from this session. Read ahead of storage, so if saving is
   *  failing (storage full), switching away and back doesn't lose the edits that never got saved. */
  private readonly boardCache = new Map<string, CanvasSnapshot>();
  /** Undo/redo stacks of boards that aren't open, so each board keeps its own history. */
  private readonly histories = new Map<string, { undo: CanvasSnapshot[]; redo: CanvasSnapshot[] }>();
  private saveTimeout: ReturnType<typeof setTimeout> | undefined;
  /** Nodes copied with copyNodes(), held app-wide (not per board) so they can be pasted onto a
   *  different board. In memory only — it doesn't survive a reload. */
  private clipboard: CanvasSnapshot | null = null;

  constructor() {
    // Persist the open board's canvas on every change, debounced so a node-drag's stream of
    // updates doesn't hit the disk on every mousemove. A debounced write can still be sitting in
    // the queue when the page reloads/closes, so it's also flushed immediately on
    // beforeunload/pagehide — otherwise the last few seconds of edits would silently vanish.
    effect(() => {
      this.nodes();
      this.connections();
      this.groupNames();
      this.activeBoardId();
      clearTimeout(this.saveTimeout);
      this.saveTimeout = setTimeout(() => this.flushSave(), 250);
    });

    // The board list is small and changes rarely (views are debounced by the caller), so it's
    // written straight away.
    effect(() => {
      const index: BoardIndex = { activeId: this.activeBoardId(), boards: this.boards() };
      this.tryWrite(BOARDS_KEY, index);
    });

    window.addEventListener('beforeunload', () => this.flushSave());
    window.addEventListener('pagehide', () => this.flushSave());
  }

  /** Writes the open board's canvas now, cancelling any pending debounced write. */
  private flushSave(): void {
    clearTimeout(this.saveTimeout);
    this.saveTimeout = undefined;
    if (this.tryWrite(boardDataKey(this.activeBoardId()), this.currentSnapshot())) this.saveError.set(null);
  }

  private tryWrite(key: string, value: unknown): boolean {
    try {
      writeJson(key, value);
      return true;
    } catch (err) {
      const quota = err instanceof DOMException && err.name === 'QuotaExceededError';
      this.saveError.set(quota
        ? 'Browser storage is full, so recent changes aren\'t being saved. Export a backup from Settings, then remove some uploaded avatars.'
        : 'Recent changes couldn\'t be saved to browser storage. Export a backup from Settings.');
      return false;
    }
  }

  private readBoard(id: string): CanvasSnapshot {
    if (id === this.activeBoardId()) return this.currentSnapshot();
    return this.boardCache.get(id) ?? readBoardData(id);
  }

  /** Swaps the open board: parks the current board's canvas and history, then loads `id`'s. */
  private loadBoard(id: string, data: CanvasSnapshot): void {
    this.commitPending();
    const leaving = this.activeBoardId();
    this.boardCache.set(leaving, this.currentSnapshot());
    this.histories.set(leaving, { undo: this.undoStack, redo: this.redoStack });

    const history = this.histories.get(id);
    this.undoStack = history?.undo ?? [];
    this.redoStack = history?.redo ?? [];
    this.activeBoardId.set(id);
    this.restore(data);
    this.selectedNodeIds.set(new Set());
  }

  /** Adds boards (at `insertAt`, default the end) and opens the first one. Every new board is
   *  written to storage right away, since only the open one goes through the debounced save. */
  private addBoards(entries: { name: string; data: CanvasSnapshot }[], insertAt = this.boards().length): BoardMeta[] {
    if (entries.length === 0) return [];
    this.flushSave();
    const metas = entries.map(e => ({ id: crypto.randomUUID(), name: e.name }));
    entries.forEach((e, i) => {
      this.boardCache.set(metas[i].id, e.data);
      this.tryWrite(boardDataKey(metas[i].id), e.data);
    });
    this.boards.update(bs => [...bs.slice(0, insertAt), ...metas, ...bs.slice(insertAt)]);
    this.loadBoard(metas[0].id, entries[0].data);
    return metas;
  }

  /** "Board N", with N one past the board count — bumped further if a board already has that name. */
  private nextBoardName(): string {
    const taken = new Set(this.boards().map(b => b.name));
    let n = this.boards().length + 1;
    while (taken.has(`Board ${n}`)) n++;
    return `Board ${n}`;
  }

  switchBoard(id: string): void {
    if (id === this.activeBoardId() || !this.boards().some(b => b.id === id)) return;
    this.flushSave();
    this.loadBoard(id, this.readBoard(id));
  }

  /** Creates an empty board and opens it. Returns its id. */
  createBoard(name = this.nextBoardName()): string {
    return this.addBoards([{ name, data: EMPTY_SNAPSHOT }])[0].id;
  }

  /** Copies a board (placed right after it) and opens the copy. Returns the copy's id. */
  duplicateBoard(id: string): string | null {
    const index = this.boards().findIndex(b => b.id === id);
    if (index < 0) return null;
    const source = this.boards()[index];
    return this.addBoards([{ name: `${source.name} copy`, data: this.readBoard(id) }], index + 1)[0].id;
  }

  /** An empty/whitespace-only name is ignored — boards always keep a visible name. */
  renameBoard(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.boards.update(bs => bs.map(b => (b.id === id && b.name !== trimmed ? { ...b, name: trimmed } : b)));
  }

  /** Moves the board at `from` to `to` in the list (e.g. from a drag in the sidebar). */
  moveBoard(from: number, to: number): void {
    const boards = this.boards();
    if (from === to || from < 0 || from >= boards.length || to < 0 || to >= boards.length) return;
    const next = [...boards];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    this.boards.set(next);
  }

  setBoardView(id: string, view: BoardView): void {
    this.boards.update(bs => bs.map(b => (b.id === id ? { ...b, view } : b)));
  }

  /** Deletes a board, opening its neighbour if it was the open one. The last board can't be
   *  deleted (returns null). Returns a function that puts the board back, for an Undo button. */
  deleteBoard(id: string): (() => void) | null {
    const boards = this.boards();
    const index = boards.findIndex(b => b.id === id);
    if (index < 0 || boards.length <= 1) return null;
    const meta = boards[index];
    const data = this.readBoard(id);

    if (id === this.activeBoardId()) {
      // Cancel the pending save so it can't rewrite the board's key after it's removed below.
      clearTimeout(this.saveTimeout);
      const neighbour = boards[index + 1] ?? boards[index - 1];
      this.loadBoard(neighbour.id, this.readBoard(neighbour.id));
    }
    this.boards.update(bs => bs.filter(b => b.id !== id));
    this.boardCache.delete(id);
    this.histories.delete(id);
    try {
      localStorage.removeItem(boardDataKey(id));
    } catch {
      // An orphaned key is harmless.
    }

    return () => {
      if (this.boards().some(b => b.id === id)) return;
      this.flushSave();
      this.boardCache.set(id, data);
      this.tryWrite(boardDataKey(id), data);
      this.boards.update(bs => [...bs.slice(0, index), meta, ...bs.slice(index)]);
      this.loadBoard(id, data);
    };
  }

  /** Replaces a board's canvas, open or not, and saves it straight away. */
  private setBoardData(id: string, data: CanvasSnapshot): void {
    if (id === this.activeBoardId()) {
      this.snapshot(); // so Cmd/Ctrl+Z can step back over it too
      this.restore(data);
      this.flushSave();
    } else {
      const history = this.histories.get(id) ?? { undo: [], redo: [] };
      history.undo.push(this.readBoard(id));
      history.redo = [];
      this.histories.set(id, history);
      this.boardCache.set(id, data);
      this.tryWrite(boardDataKey(id), data);
    }
  }

  /** Empties boards — removes every node, connection and group name — but keeps the boards
   *  themselves (name, place in the list, view). Returns a function that puts their contents
   *  back, for an Undo button. */
  clearBoards(ids: Iterable<string>): () => void {
    const existing = new Set(this.boards().map(b => b.id));
    const saved = [...new Set(ids)].filter(id => existing.has(id)).map(id => ({ id, data: this.readBoard(id) }));
    for (const { id } of saved) this.setBoardData(id, EMPTY_SNAPSHOT);

    return () => {
      for (const { id, data } of saved) {
        if (this.boards().some(b => b.id === id)) this.setBoardData(id, data);
      }
    };
  }

  /** Deletes every board and everything on them, leaving one new empty board. Returns a function
   *  that brings them all back (boards made since are kept, after them), for an Undo button. */
  clearAllBoards(): () => void {
    this.flushSave();
    const prevBoards = this.boards();
    const prevActive = this.activeBoardId();
    const saved = new Map(prevBoards.map(b => [b.id, this.readBoard(b.id)]));

    const fresh: BoardMeta = { id: crypto.randomUUID(), name: 'My board' };
    this.tryWrite(boardDataKey(fresh.id), EMPTY_SNAPSHOT);
    this.boards.set([fresh]);
    this.loadBoard(fresh.id, EMPTY_SNAPSHOT);
    this.boardCache.clear();
    this.histories.clear();
    for (const id of saved.keys()) this.removeBoardKey(id);

    return () => {
      this.flushSave();
      // The empty board that replaced them goes again, unless something's been added to it.
      const keepFresh = this.readBoard(fresh.id).nodes.length > 0;
      const since = this.boards().filter(b => !saved.has(b.id) && (keepFresh || b.id !== fresh.id));
      for (const [id, data] of saved) {
        this.boardCache.set(id, data);
        this.tryWrite(boardDataKey(id), data);
      }
      this.boards.set([...prevBoards, ...since]);
      this.loadBoard(prevActive, saved.get(prevActive)!);
      if (!keepFresh) {
        this.boardCache.delete(fresh.id);
        this.histories.delete(fresh.id);
        this.removeBoardKey(fresh.id);
      }
    };
  }

  private removeBoardKey(id: string): void {
    try {
      localStorage.removeItem(boardDataKey(id));
    } catch {
      // An orphaned key is harmless.
    }
  }

  // ── Undo / redo ──────────────────────────────────────────────────────────
  // Whole-state snapshots rather than per-action inverses — simplest way to make an arbitrary
  // mix of node/connection/group-name mutations undoable without hand-writing an inverse for
  // each one. Every array/object here is only ever replaced (never mutated in place), so a
  // captured reference stays untouched by later changes — no cloning needed.

  private undoStack: CanvasSnapshot[] = [];
  private redoStack: CanvasSnapshot[] = [];
  /** State captured by the latest snapshot() call, not yet known to precede a real change. It only
   *  becomes an undo step once the state has actually moved on from it (see commitPending), so
   *  e.g. clicking a node — which snapshots for a drag that never happens — doesn't leave an undo
   *  step that does nothing, or wipe the redo stack. */
  private pending: CanvasSnapshot | null = null;

  private currentSnapshot(): CanvasSnapshot {
    return { nodes: this.nodes(), connections: this.connections(), groupNames: this.groupNames() };
  }

  private restore(snap: CanvasSnapshot): void {
    this.nodes.set(snap.nodes);
    this.connections.set(snap.connections);
    this.groupNames.set(snap.groupNames);
    this.pruneSelection();
  }

  /** Drops selected ids whose node no longer exists (after an undo/redo/import replaced the nodes). */
  private pruneSelection(): void {
    const ids = new Set(this.nodes().map(n => n.id));
    const selected = this.selectedNodeIds();
    if ([...selected].every(id => ids.has(id))) return;
    this.selectedNodeIds.set(new Set([...selected].filter(id => ids.has(id))));
  }

  private commitPending(): void {
    if (this.pending && !sameSnapshot(this.pending, this.currentSnapshot())) {
      this.undoStack.push(this.pending);
      this.redoStack = [];
    }
    this.pending = null;
  }

  /** Call once immediately before a discrete user-initiated change (add/delete/edit/connect/group/
   *  drag-start...), so it becomes a single undo step. Don't call this on every tick of a continuous
   *  gesture like a drag — snapshot once before the gesture starts, not on every mousemove. */
  snapshot(): void {
    this.commitPending();
    this.pending = this.currentSnapshot();
  }

  undo(): boolean {
    this.commitPending();
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.currentSnapshot());
    this.restore(prev);
    return true;
  }

  redo(): boolean {
    this.commitPending();
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.currentSnapshot());
    this.restore(next);
    return true;
  }

  // ── Export / import ──────────────────────────────────────────────────────

  /** The open board, in the single-board export format. */
  exportSnapshot(): CanvasExport {
    return { version: 1, name: this.activeBoard().name, ...this.currentSnapshot() };
  }

  /** Every board, in order. */
  exportAllBoards(): CanvasBundleExport {
    return {
      version: 1,
      boards: this.boards().map(b => ({ version: 1, name: b.name, ...this.readBoard(b.id) })),
    };
  }

  /** Adds the boards in an exported file — one board or a bundle of every board — as new boards
   *  beside the existing ones (never replacing anything), and opens the first. Boards with no
   *  name of their own (files from before boards existed) are named `fallbackName`. Throws, with
   *  a message fit for the user, on an unrecognized file — adding nothing. */
  importBoards(data: unknown, fallbackName: string): BoardMeta[] {
    const parsed = parseImport(data);
    return this.addBoards(parsed.map((b, i) => ({
      name: b.name ?? (parsed.length > 1 ? `${fallbackName} ${i + 1}` : fallbackName),
      data: { nodes: b.nodes, connections: b.connections, groupNames: b.groupNames },
    })));
  }

  getGroupName(groupId: string): string {
    return this.groupNames()[groupId]?.trim() || 'Group';
  }

  /** Renaming to an empty/whitespace-only name reverts the group to the default "Group" label. */
  setGroupName(groupId: string, name: string): void {
    const trimmed = name.trim();
    this.groupNames.update(names => {
      const next = { ...names };
      if (trimmed) next[groupId] = trimmed;
      else delete next[groupId];
      return next;
    });
  }

  getNode(id: string): GrindNode | undefined {
    return this.nodes().find(n => n.id === id);
  }

  /** Replaces the selection with a single node (or clears it if `id` is null) — used for a plain click. */
  selectOnly(id: string | null): void {
    this.selectedNodeIds.set(id ? new Set([id]) : new Set());
  }

  /** Replaces the selection with an arbitrary set of nodes — used by marquee/rubber-band selection. */
  setSelection(ids: readonly string[]): void {
    this.selectedNodeIds.set(new Set(ids));
  }

  addNode(x: number, y: number): string {
    const id = crypto.randomUUID();
    this.nodes.update(ns => [...ns, {
      id, x, y,
      title: 'New Grind',
      notes: '',
      completed: false,
    }]);
    return id;
  }

  updateNode(id: string, updates: Partial<GrindNode>): void {
    this.nodes.update(ns => ns.map(n => n.id === id ? { ...n, ...updates } : n));
  }

  /** Moves many nodes at once (one signal update), e.g. after an auto-organise. */
  setNodePositions(positions: ReadonlyMap<string, { x: number; y: number }>): void {
    this.nodes.update(ns => ns.map(n => {
      const p = positions.get(n.id);
      return p ? { ...n, x: p.x, y: p.y } : n;
    }));
  }

  deleteNode(id: string): void {
    this.nodes.update(ns => ns.filter(n => n.id !== id));
    this.connections.update(cs => cs.filter(c =>
      !(c.fromKind === 'node' && c.fromId === id) && !(c.toKind === 'node' && c.toId === id)
    ));
    if (this.selectedNodeIds().has(id)) {
      const next = new Set(this.selectedNodeIds());
      next.delete(id);
      this.selectedNodeIds.set(next);
    }
    this.pruneOrphanedGroupData();
  }

  /**
   * Snapshots nodes plus the connections and groups that only involve them — the shared core of
   * copy and group-duplicate. A group comes along only if at least two of its members are
   * included (a lone member comes out ungrouped, rather than as a group of one), and connections
   * to anything left out are dropped. Null if none of the ids exist.
   */
  private extractNodes(ids: Iterable<string>): CanvasSnapshot | null {
    const idSet = new Set(ids);
    const nodes = this.nodes().filter(n => idSet.has(n.id));
    if (nodes.length === 0) return null;

    const memberCounts = new Map<string, number>();
    for (const n of nodes) if (n.groupId) memberCounts.set(n.groupId, (memberCounts.get(n.groupId) ?? 0) + 1);
    const keptGroups = new Set([...memberCounts].filter(([, count]) => count >= 2).map(([g]) => g));

    const included = (id: string, kind: EndpointKind) => (kind === 'node' ? idSet : keptGroups).has(id);
    return {
      nodes: nodes.map(({ groupId, ...rest }) => (groupId && keptGroups.has(groupId) ? { ...rest, groupId } : rest)),
      connections: this.connections().filter(c => included(c.fromId, c.fromKind) && included(c.toId, c.toKind)),
      groupNames: Object.fromEntries(Object.entries(this.groupNames()).filter(([g]) => keptGroups.has(g))),
    };
  }

  /** Nominal bounding box of a set of nodes (node cards size to content, so this is approximate). */
  private boundsOf(nodes: GrindNode[]): { minX: number; minY: number; maxX: number; maxY: number } {
    return {
      minX: Math.min(...nodes.map(n => n.x)),
      minY: Math.min(...nodes.map(n => n.y)),
      maxX: Math.max(...nodes.map(n => n.x + NODE_WIDTH)),
      maxY: Math.max(...nodes.map(n => n.y + NODE_HEIGHT)),
    };
  }

  /** Adds a snapshot's contents to the open board with fresh ids, shifted by (dx, dy), and
   *  selects the new nodes. Returns their ids. */
  private insertNodes(clip: CanvasSnapshot, dx: number, dy: number): string[] {
    const nodeIds = new Map(clip.nodes.map(n => [n.id, crypto.randomUUID()]));
    const groupIds = new Map<string, string>();
    for (const n of clip.nodes) if (n.groupId && !groupIds.has(n.groupId)) groupIds.set(n.groupId, crypto.randomUUID());
    const remap = (id: string, kind: EndpointKind) => (kind === 'node' ? nodeIds : groupIds).get(id)!;

    const nodes = clip.nodes.map(n => ({
      ...n,
      id: nodeIds.get(n.id)!,
      x: n.x + dx,
      y: n.y + dy,
      ...(n.groupId ? { groupId: groupIds.get(n.groupId)! } : {}),
    }));
    const connections = clip.connections.map(c => ({
      ...c,
      id: crypto.randomUUID(),
      fromId: remap(c.fromId, c.fromKind),
      toId: remap(c.toId, c.toKind),
    }));
    const names = Object.fromEntries(Object.entries(clip.groupNames).map(([g, name]) => [groupIds.get(g)!, name]));

    this.nodes.update(ns => [...ns, ...nodes]);
    if (connections.length) this.connections.update(cs => [...cs, ...connections]);
    if (Object.keys(names).length) this.groupNames.update(gn => ({ ...gn, ...names }));
    const ids = [...nodeIds.values()];
    this.setSelection(ids);
    return ids;
  }

  /** Copies nodes (with their connections and groups — see extractNodes) for pasteNodes().
   *  Returns how many nodes were copied. */
  copyNodes(ids: Iterable<string>): number {
    const clip = this.extractNodes(ids);
    if (!clip) return 0;
    this.clipboard = clip;
    return clip.nodes.length;
  }

  /** The copied nodes as text for the system clipboard, so they can be pasted into another tab
   *  or another copy of the app (e.g. the local dev site → the live site). Null if nothing's
   *  been copied. */
  clipboardText(): string | null {
    if (!this.clipboard) return null;
    return JSON.stringify({ [CLIPBOARD_MARKER]: 1, ...this.clipboard });
  }

  /** Loads nodes copied by clipboardText() — from any tab or copy of the app — as the clipboard.
   *  Returns how many nodes it holds, or 0 (clipboard left as it was) if the text isn't ours. */
  loadClipboardText(text: string): number {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return 0;
    }
    if (!isRecord(data) || data[CLIPBOARD_MARKER] !== 1) return 0;
    try {
      const { nodes, connections, groupNames } = parseCanvasExport(data);
      if (nodes.length === 0) return 0;
      this.clipboard = { nodes, connections, groupNames };
      return nodes.length;
    } catch {
      return 0;
    }
  }

  /** How many nodes are waiting to be pasted (0 if nothing's been copied). */
  clipboardSize(): number {
    return this.clipboard?.nodes.length ?? 0;
  }

  /** Pastes the copied nodes onto the open board with fresh ids (so it works any number of times,
   *  on any board), centered on (x, y) with their layout kept, and selects them. Returns the new
   *  node ids — empty if nothing has been copied. Callers snapshot() first, as with any change. */
  pasteNodes(x: number, y: number): string[] {
    const clip = this.clipboard;
    if (!clip) return [];
    const b = this.boundsOf(clip.nodes);
    return this.insertNodes(clip, Math.round(x - (b.minX + b.maxX) / 2), Math.round(y - (b.minY + b.maxY) / 2));
  }

  /** Duplicates a whole group — members, name, and the connections between them — placed just to
   *  the right of the original so the two group outlines don't overlap. Leaves the clipboard
   *  alone. Returns the new node ids. Callers snapshot() first. */
  duplicateGroup(groupId: string): string[] {
    const clip = this.extractNodes(this.nodes().filter(n => n.groupId === groupId).map(n => n.id));
    if (!clip) return [];
    const b = this.boundsOf(clip.nodes);
    return this.insertNodes(clip, b.maxX - b.minX + 80, 0);
  }

  duplicateNode(id: string): string {
    const node = this.getNode(id);
    if (!node) return '';
    const newId = crypto.randomUUID();
    this.nodes.update(ns => [...ns, { ...node, id: newId, x: node.x + 32, y: node.y + 32 }]);
    return newId;
  }

  /** A node connecting to the group that already contains it (or vice versa) is a self-loop too. */
  isSelfLoop(aId: string, aKind: EndpointKind, bId: string, bKind: EndpointKind): boolean {
    if (aId === bId && aKind === bKind) return true;
    const nodeEnd = aKind === 'node' ? aId : bKind === 'node' ? bId : null;
    const groupEnd = aKind === 'group' ? aId : bKind === 'group' ? bId : null;
    if (nodeEnd && groupEnd) return this.getNode(nodeEnd)?.groupId === groupEnd;
    return false;
  }

  addConnection(fromId: string, fromKind: EndpointKind, fromSide: NodeSide, toId: string, toKind: EndpointKind, toSide: NodeSide): void {
    if (this.isSelfLoop(fromId, fromKind, toId, toKind)) return;
    if (this.connections().some(c => c.fromId === fromId && c.fromKind === fromKind && c.toId === toId && c.toKind === toKind)) return;
    const id = crypto.randomUUID();
    this.connections.update(cs => [...cs, { id, fromId, fromKind, fromSide, toId, toKind, toSide }]);
  }

  removeConnection(id: string): void {
    this.connections.update(cs => cs.filter(c => c.id !== id));
  }

  /** Splits connection A → B into A → inserted → B (e.g. dropping a node onto a line). A and B
   *  keep the sides they were already attached on; `inSide`/`outSide` are where the two new links
   *  attach to the inserted node/group. Returns false (changing nothing) if either new link would
   *  be a self-loop. */
  spliceIntoConnection(connId: string, id: string, kind: EndpointKind, inSide: NodeSide, outSide: NodeSide): boolean {
    const c = this.connections().find(conn => conn.id === connId);
    if (!c) return false;
    if (this.isSelfLoop(c.fromId, c.fromKind, id, kind) || this.isSelfLoop(id, kind, c.toId, c.toKind)) return false;
    this.removeConnection(connId);
    this.addConnection(c.fromId, c.fromKind, c.fromSide, id, kind, inSide);
    this.addConnection(id, kind, outSide, c.toId, c.toKind, c.toSide);
    return true;
  }

  /** A connection's source is satisfied once it's completed — or, for a group source, once every
   *  member of that group is (vacuously true for an empty group, which shouldn't occur since
   *  pruneOrphanedGroupData drops connections attached to a group with no members left). */
  private isConnectionSatisfied(c: NodeConnection): boolean {
    if (c.fromKind === 'node') return !!this.getNode(c.fromId)?.completed;
    return this.nodes().filter(n => n.groupId === c.fromId).every(n => n.completed);
  }

  /** Every connection is a prereq gate. A node is locked until all connections pointing at it —
   *  directly, or at the group it belongs to — are satisfied. Grouping is one level deep, so a
   *  group target just means "gate every member the same way," no recursion involved. */
  prereqStatus(nodeId: string): { total: number; satisfied: number; locked: boolean } {
    if (!this.settings.prereqsEnabled()) return { total: 0, satisfied: 0, locked: false };
    const groupId = this.getNode(nodeId)?.groupId;
    const prereqs = this.connections().filter(c =>
      (c.toKind === 'node' && c.toId === nodeId) ||
      (c.toKind === 'group' && !!groupId && c.toId === groupId)
    );
    const total = prereqs.length;
    const satisfied = prereqs.filter(c => this.isConnectionSatisfied(c)).length;
    return { total, satisfied, locked: satisfied < total };
  }

  /** Rewires one end of an existing connection to a different node/group/side (e.g. dragging an endpoint handle). */
  updateConnection(id: string, updates: Partial<Omit<NodeConnection, 'id'>>): void {
    const conn = this.connections().find(c => c.id === id);
    if (!conn) return;
    const next = { ...conn, ...updates };
    // Leave the array untouched (same reference) on a rejected rewire, so it isn't seen as a change.
    if (this.isSelfLoop(next.fromId, next.fromKind, next.toId, next.toKind)) return;
    this.connections.update(cs => cs.map(c => (c.id === id ? next : c)));
  }

  groupNodes(sourceId: string, targetId: string): void {
    const target = this.getNode(targetId);
    if (!target) return;
    const groupId = target.groupId ?? crypto.randomUUID();
    this.updateNode(targetId, { groupId });
    this.updateNode(sourceId, { groupId });
    // The source may have been the last member of its old group.
    this.pruneOrphanedGroupData();
  }

  /** Groups an arbitrary set of nodes together in one go (e.g. from a multi-select context menu action). Reuses an existing group id among them if there is one, so it merges rather than orphaning that group. */
  groupNodesTogether(ids: string[]): void {
    if (ids.length < 2) return;
    const existingGroupId = ids.map(id => this.getNode(id)?.groupId).find((gid): gid is string => !!gid);
    const groupId = existingGroupId ?? crypto.randomUUID();
    for (const id of ids) this.updateNode(id, { groupId });
    // Merging can empty out other groups the selection came from.
    this.pruneOrphanedGroupData();
  }

  ungroupNode(nodeId: string): void {
    this.updateNode(nodeId, { groupId: undefined });
    this.pruneOrphanedGroupData();
  }

  /** Drops any connection or custom name still attached to a group id that no node belongs to anymore. */
  private pruneOrphanedGroupData(): void {
    const validGroupIds = new Set(this.nodes().map(n => n.groupId).filter((id): id is string => !!id));
    this.connections.update(cs => {
      const kept = cs.filter(c =>
        (c.fromKind !== 'group' || validGroupIds.has(c.fromId)) &&
        (c.toKind !== 'group' || validGroupIds.has(c.toId))
      );
      // Same reference when nothing was dropped, so undo doesn't see a change that didn't happen.
      return kept.length === cs.length ? cs : kept;
    });
    this.groupNames.update(names => {
      const next = { ...names };
      let changed = false;
      for (const id of Object.keys(next)) {
        if (!validGroupIds.has(id)) { delete next[id]; changed = true; }
      }
      return changed ? next : names;
    });
  }
}
