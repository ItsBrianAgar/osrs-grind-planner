import { Injectable, effect, inject, signal } from '@angular/core';
import { GrindNode, NodeSide } from '../models/grind-node.model';
import { EndpointKind, NodeConnection } from '../models/connection.model';
import { SettingsService } from './settings.service';

const NODES_KEY = 'osrs-canvas-nodes';
const CONNECTIONS_KEY = 'osrs-canvas-connections';
const GROUP_NAMES_KEY = 'osrs-canvas-group-names';

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

@Injectable({ providedIn: 'root' })
export class CanvasService {
  private readonly settings = inject(SettingsService);

  readonly nodes = signal<GrindNode[]>(loadFromStorage(NODES_KEY, []));
  readonly connections = signal<NodeConnection[]>(
    loadFromStorage<NodeConnection[]>(CONNECTIONS_KEY, []).map(normalizeConnection)
  );
  readonly selectedNodeIds = signal<ReadonlySet<string>>(new Set());
  /** Custom group display names, keyed by group id — groups otherwise just show "Group". */
  readonly groupNames = signal<Record<string, string>>(loadFromStorage(GROUP_NAMES_KEY, {}));

  constructor() {
    // Persist the canvas to localStorage on every change, debounced so a node-drag's stream
    // of updates doesn't hit the disk on every mousemove. A debounced write can still be
    // sitting in the queue when the page reloads/closes, so it's also flushed immediately
    // on beforeunload/pagehide — otherwise the last few seconds of edits would silently vanish.
    let saveTimeout: ReturnType<typeof setTimeout> | undefined;
    let latestNodes = this.nodes();
    let latestConnections = this.connections();
    let latestGroupNames = this.groupNames();

    const flush = () => {
      clearTimeout(saveTimeout);
      saveTimeout = undefined;
      localStorage.setItem(NODES_KEY, JSON.stringify(latestNodes));
      localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(latestConnections));
      localStorage.setItem(GROUP_NAMES_KEY, JSON.stringify(latestGroupNames));
    };

    effect(() => {
      latestNodes = this.nodes();
      latestConnections = this.connections();
      latestGroupNames = this.groupNames();
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(flush, 250);
    });

    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
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
      category: this.settings.categoriesEnabled() ? 'general' : 'item',
      completed: false,
    }]);
    return id;
  }

  updateNode(id: string, updates: Partial<GrindNode>): void {
    this.nodes.update(ns => ns.map(n => n.id === id ? { ...n, ...updates } : n));
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

  duplicateNode(id: string): string {
    const node = this.getNode(id);
    if (!node) return '';
    const newId = crypto.randomUUID();
    this.nodes.update(ns => [...ns, { ...node, id: newId, x: node.x + 32, y: node.y + 32 }]);
    return newId;
  }

  /** A node connecting to the group that already contains it (or vice versa) is a self-loop too. */
  private isSelfLoop(aId: string, aKind: EndpointKind, bId: string, bKind: EndpointKind): boolean {
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

  /** Rewires one end of an existing connection to a different node/group/side (e.g. dragging an endpoint handle). */
  updateConnection(id: string, updates: Partial<Omit<NodeConnection, 'id'>>): void {
    this.connections.update(cs => cs.map(c => {
      if (c.id !== id) return c;
      const next = { ...c, ...updates };
      if (this.isSelfLoop(next.fromId, next.fromKind, next.toId, next.toKind)) return c;
      return next;
    }));
  }

  groupNodes(sourceId: string, targetId: string): void {
    const target = this.getNode(targetId);
    if (!target) return;
    const groupId = target.groupId ?? crypto.randomUUID();
    this.updateNode(targetId, { groupId });
    this.updateNode(sourceId, { groupId });
  }

  /** Groups an arbitrary set of nodes together in one go (e.g. from a multi-select context menu action). Reuses an existing group id among them if there is one, so it merges rather than orphaning that group. */
  groupNodesTogether(ids: string[]): void {
    if (ids.length < 2) return;
    const existingGroupId = ids.map(id => this.getNode(id)?.groupId).find((gid): gid is string => !!gid);
    const groupId = existingGroupId ?? crypto.randomUUID();
    for (const id of ids) this.updateNode(id, { groupId });
  }

  ungroupNode(nodeId: string): void {
    this.updateNode(nodeId, { groupId: undefined });
    this.pruneOrphanedGroupData();
  }

  /** Drops any connection or custom name still attached to a group id that no node belongs to anymore. */
  private pruneOrphanedGroupData(): void {
    const validGroupIds = new Set(this.nodes().map(n => n.groupId).filter((id): id is string => !!id));
    this.connections.update(cs => cs.filter(c =>
      (c.fromKind !== 'group' || validGroupIds.has(c.fromId)) &&
      (c.toKind !== 'group' || validGroupIds.has(c.toId))
    ));
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
