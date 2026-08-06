import { Component, HostListener, computed, inject, signal, ViewChild } from '@angular/core';
import { NgFor, NgIf, DecimalPipe } from '@angular/common';
import { CanvasService } from '../../services/canvas.service';
import { NodeMetricsService } from '../../services/node-metrics.service';
import { ToolService } from '../../services/tool.service';
import { Box, sidePoint, nearestSide, Size } from '../../utils/node-geometry';
import { GrindNodeComponent } from '../grind-node/grind-node.component';
import { ConnectionsLayerComponent, PendingConnection, ReconnectingEnd } from '../connections-layer/connections-layer.component';
import { NodeEditorComponent } from '../node-editor/node-editor.component';
import { SettingsDialogComponent } from '../settings-dialog/settings-dialog.component';
import { GrindNode, NODE_WIDTH, NODE_HEIGHT, GROUP_PADDING, GROUP_HEADER_HEIGHT, NodeSide } from '../../models/grind-node.model';
import { EndpointKind } from '../../models/connection.model';
import { GroupBound } from '../../models/group.model';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { ContextMenu, ContextMenuModule } from 'primeng/contextmenu';
import { MenuItem, MessageService } from 'primeng/api';
import { AutofocusSelectDirective } from '../../directives/autofocus-select.directive';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ConnTarget {
  id: string;
  kind: EndpointKind;
}

@Component({
  selector: 'app-workspace',
  standalone: true,
  imports: [
    NgFor, NgIf, DecimalPipe,
    GrindNodeComponent,
    ConnectionsLayerComponent,
    NodeEditorComponent,
    SettingsDialogComponent,
    ButtonModule,
    ToastModule,
    TooltipModule,
    ContextMenuModule,
    AutofocusSelectDirective,
  ],
  providers: [MessageService],
  templateUrl: './workspace.component.html',
  styleUrl: './workspace.component.scss',
})
export class WorkspaceComponent {
  readonly canvas = inject(CanvasService);
  readonly tools = inject(ToolService);
  private readonly metrics = inject(NodeMetricsService);
  private readonly msg = inject(MessageService);

  @ViewChild('ctxMenu') ctxMenu!: ContextMenu;

  // Viewport transform
  readonly panX = signal(0);
  readonly panY = signal(0);
  readonly zoom = signal(1);

  readonly transform = computed(() =>
    `translate(${this.panX()}px, ${this.panY()}px) scale(${this.zoom()})`
  );

  readonly gridStyle = computed(() => {
    const size = 28 * this.zoom();
    return {
      'background-image': this.zoom() < 0.75 ? 'none' : 'radial-gradient(circle, #2a2416 1.2px, transparent 1.2px)',
      'background-size': `${size}px ${size}px`,
      'background-position': `${this.panX() % size}px ${this.panY() % size}px`,
    };
  });

  // Drag node state — all nodes being moved (the whole selection, if the grabbed node is part of it)
  private draggingNodeId = signal<string | null>(null);
  private dragStartMouse = { x: 0, y: 0 };
  private dragGroupStartPositions = new Map<string, { x: number; y: number }>();

  // Panning / marquee-select state — mutually exclusive, chosen by the active tool at mousedown
  private dragMode: 'pan' | 'marquee' | null = null;
  private panStartMouse = { x: 0, y: 0 };
  private panStartValue = { x: 0, y: 0 };
  private marqueeStart = { x: 0, y: 0 };
  readonly marqueeRect = signal<Rect | null>(null);

  // Connection drawing state
  readonly pendingConn = signal<PendingConnection | null>(null);
  readonly reconnecting = signal<ReconnectingEnd | null>(null);

  // Mouse world position (for hit tests)
  private mouseWorld = { x: 0, y: 0 };

  // Derived highlight states
  readonly groupDropTargetId = signal<string | null>(null);
  readonly connTarget = signal<ConnTarget | null>(null);

  // Editor
  readonly editingNodeId = signal<string | null>(null);
  readonly editingGroupId = signal<string | null>(null);

  // Settings
  readonly settingsVisible = signal(false);

  // Context menu items (built per-node on right-click)
  contextMenuItems: MenuItem[] = [];

  // Group bounds for rendering group containers
  readonly groupBounds = computed<GroupBound[]>(() => {
    const nodes = this.canvas.nodes();
    const map = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();

    for (const n of nodes) {
      if (!n.groupId) continue;
      const size = this.sizeOf(n.id);
      const g = map.get(n.groupId) ?? { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      g.minX = Math.min(g.minX, n.x);
      g.minY = Math.min(g.minY, n.y);
      g.maxX = Math.max(g.maxX, n.x + size.width);
      g.maxY = Math.max(g.maxY, n.y + size.height);
      map.set(n.groupId, g);
    }

    return [...map.entries()].map(([id, g]) => ({
      id,
      x: g.minX - GROUP_PADDING,
      y: g.minY - GROUP_HEADER_HEIGHT,
      width: g.maxX - g.minX + GROUP_PADDING * 2,
      height: g.maxY - g.minY + GROUP_PADDING + GROUP_HEADER_HEIGHT,
    }));
  });

  // ── Workspace-level mouse handlers ───────────────────────────────────────

  onViewportMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;

    if (this.tools.effectiveTool() === 'hand') {
      this.dragMode = 'pan';
      this.panStartMouse = { x: event.clientX, y: event.clientY };
      this.panStartValue = { x: this.panX(), y: this.panY() };
    } else {
      this.dragMode = 'marquee';
      const world = this.toWorld(event);
      this.marqueeStart = world;
      this.marqueeRect.set({ x: world.x, y: world.y, width: 0, height: 0 });
      this.canvas.setSelection([]);
    }
  }

  private rectsIntersect(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.width && a.x + a.width > b.x &&
           a.y < b.y + b.height && a.y + a.height > b.y;
  }

  /** Converts a screen-space mouse event into world coordinates, correcting for the viewport
   *  element's own on-screen offset (e.g. the toolbar above it) — not just pan/zoom. */
  private toWorld(event: MouseEvent): { x: number; y: number } {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - this.panX()) / this.zoom(),
      y: (event.clientY - rect.top - this.panY()) / this.zoom(),
    };
  }

  /** Node cards size to their content, so hit-tests/ports use the actual rendered size — not a nominal constant. */
  private sizeOf(nodeId: string): Size {
    return this.metrics.get(nodeId) ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
  }

  /** Resolves a connection endpoint (a node or a group id) to its box position + size. */
  private resolveTargetBox(id: string, kind: EndpointKind): { box: Box; size: Size } | null {
    if (kind === 'group') {
      const g = this.groupBounds().find(gb => gb.id === id);
      return g ? { box: g, size: { width: g.width, height: g.height } } : null;
    }
    const n = this.canvas.getNode(id);
    return n ? { box: n, size: this.sizeOf(id) } : null;
  }

  /**
   * Whichever node or group the cursor is currently over, valid as a connection endpoint given
   * what the other (fixed) end already is — nodes take priority over the group enclosing them,
   * so hovering a card targets the card and hovering the group's padding targets the group.
   * Excludes anything that would form a self-loop (the fixed endpoint itself, a node connecting
   * to its own group, or a group connecting to one of its own members).
   */
  private hitTestConnectionTarget(fixedId: string, fixedKind: EndpointKind): ConnTarget | null {
    const nodes = this.canvas.nodes();

    const hitNode = nodes.find(n => {
      if (fixedKind === 'node' && n.id === fixedId) return false;
      if (fixedKind === 'group' && n.groupId === fixedId) return false;
      const size = this.sizeOf(n.id);
      return this.mouseWorld.x >= n.x && this.mouseWorld.x <= n.x + size.width &&
             this.mouseWorld.y >= n.y && this.mouseWorld.y <= n.y + size.height;
    });
    if (hitNode) return { id: hitNode.id, kind: 'node' };

    const hitGroup = this.groupBounds().find(g => {
      if (fixedKind === 'group' && g.id === fixedId) return false;
      if (fixedKind === 'node' && nodes.find(n => n.id === fixedId)?.groupId === g.id) return false;
      return this.mouseWorld.x >= g.x && this.mouseWorld.x <= g.x + g.width &&
             this.mouseWorld.y >= g.y && this.mouseWorld.y <= g.y + g.height;
    });
    if (hitGroup) return { id: hitGroup.id, kind: 'group' };

    return null;
  }

  onViewportMouseMove(event: MouseEvent): void {
    this.mouseWorld = this.toWorld(event);

    if (this.dragMode === 'pan') {
      this.panX.set(this.panStartValue.x + event.clientX - this.panStartMouse.x);
      this.panY.set(this.panStartValue.y + event.clientY - this.panStartMouse.y);
    }

    if (this.dragMode === 'marquee') {
      const x = Math.min(this.marqueeStart.x, this.mouseWorld.x);
      const y = Math.min(this.marqueeStart.y, this.mouseWorld.y);
      const width = Math.abs(this.mouseWorld.x - this.marqueeStart.x);
      const height = Math.abs(this.mouseWorld.y - this.marqueeStart.y);
      const rect: Rect = { x, y, width, height };
      this.marqueeRect.set(rect);

      const ids = this.canvas.nodes()
        .filter(n => this.rectsIntersect(rect, { x: n.x, y: n.y, ...this.sizeOf(n.id) }))
        .map(n => n.id);
      this.canvas.setSelection(ids);
    }

    if (this.draggingNodeId()) {
      const dx = (event.clientX - this.dragStartMouse.x) / this.zoom();
      const dy = (event.clientY - this.dragStartMouse.y) / this.zoom();
      for (const [id, startPos] of this.dragGroupStartPositions) {
        this.canvas.updateNode(id, { x: startPos.x + dx, y: startPos.y + dy });
      }

      // Grouping-by-drop only makes sense for a single dragged node — skip it for a group drag.
      if (this.dragGroupStartPositions.size === 1) {
        const target = this.canvas.nodes().find(n =>
          !this.dragGroupStartPositions.has(n.id) &&
          this.mouseWorld.x >= n.x && this.mouseWorld.x <= n.x + NODE_WIDTH &&
          this.mouseWorld.y >= n.y && this.mouseWorld.y <= n.y + NODE_HEIGHT
        );
        this.groupDropTargetId.set(target?.id ?? null);
      } else {
        this.groupDropTargetId.set(null);
      }
    }

    if (this.pendingConn()) {
      this.pendingConn.update(pc => pc ? { ...pc, worldX: this.mouseWorld.x, worldY: this.mouseWorld.y } : null);
      const pc = this.pendingConn()!;
      this.connTarget.set(this.hitTestConnectionTarget(pc.fromId, pc.fromKind));
    }

    if (this.reconnecting()) {
      this.reconnecting.update(r => r ? { ...r, worldX: this.mouseWorld.x, worldY: this.mouseWorld.y } : null);

      const rc = this.reconnecting()!;
      const conn = this.canvas.connections().find(c => c.id === rc.connId);
      if (conn) {
        const fixedId = rc.end === 'from' ? conn.toId : conn.fromId;
        const fixedKind = rc.end === 'from' ? conn.toKind : conn.fromKind;
        this.connTarget.set(this.hitTestConnectionTarget(fixedId, fixedKind));
      } else {
        this.connTarget.set(null);
      }
    }
  }

  onViewportMouseUp(event: MouseEvent): void {
    const gdt = this.groupDropTargetId();
    if (this.draggingNodeId() && gdt) {
      this.canvas.groupNodes(this.draggingNodeId()!, gdt);
      this.msg.add({ severity: 'success', summary: 'Grouped', detail: 'Nodes added to a group', life: 1800 });
    }

    const pc = this.pendingConn();
    if (pc) {
      const target = this.connTarget();
      if (target) {
        const resolved = this.resolveTargetBox(target.id, target.kind);
        if (resolved) {
          // Whichever side of the target the cursor is over at drop time — not a geometric guess.
          const toSide = nearestSide(resolved.box, resolved.size, this.mouseWorld.x, this.mouseWorld.y);
          this.canvas.snapshot();
          this.canvas.addConnection(pc.fromId, pc.fromKind, pc.fromSide, target.id, target.kind, toSide);
        }
      }
    }

    const rc = this.reconnecting();
    if (rc) {
      const target = this.connTarget();
      if (target) {
        const resolved = this.resolveTargetBox(target.id, target.kind);
        if (resolved) {
          const newSide = nearestSide(resolved.box, resolved.size, this.mouseWorld.x, this.mouseWorld.y);
          this.canvas.snapshot();
          if (rc.end === 'from') this.canvas.updateConnection(rc.connId, { fromId: target.id, fromKind: target.kind, fromSide: newSide });
          else this.canvas.updateConnection(rc.connId, { toId: target.id, toKind: target.kind, toSide: newSide });
        }
      }
    }

    this.dragMode = null;
    this.marqueeRect.set(null);
    this.draggingNodeId.set(null);
    this.dragGroupStartPositions.clear();
    this.pendingConn.set(null);
    this.reconnecting.set(null);
    this.groupDropTargetId.set(null);
    this.connTarget.set(null);
  }

  onViewportWheel(event: WheelEvent): void {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newZoom = Math.max(0.08, Math.min(4, this.zoom() * factor));
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    this.panX.set(mx - (mx - this.panX()) * (newZoom / this.zoom()));
    this.panY.set(my - (my - this.panY()) * (newZoom / this.zoom()));
    this.zoom.set(newZoom);
  }

  onViewportDblClick(event: MouseEvent): void {
    if (this.tools.effectiveTool() === 'hand') return;
    if ((event.target as HTMLElement).closest('app-grind-node')) return;
    const { x: wx, y: wy } = this.toWorld(event);
    this.canvas.snapshot();
    const id = this.canvas.addNode(wx - NODE_WIDTH / 2, wy - NODE_HEIGHT / 2);
    this.editingNodeId.set(id);
  }

  // ── Tool switching (keyboard) ─────────────────────────────────────────────

  @HostListener('window:keydown', ['$event'])
  onWindowKeyDown(event: KeyboardEvent): void {
    if (this.isTypingTarget(event)) return;

    if (event.code === 'Space') {
      if (!event.repeat) this.tools.setSpaceHeld(true);
      event.preventDefault();
      return;
    }

    // Cmd/Ctrl+Z to undo, +Shift to redo — checked ahead of the modifier-key early-return below,
    // since that return exists specifically to ignore other shortcuts (browser zoom, etc).
    const modKey = event.metaKey || event.ctrlKey;
    if (modKey && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.canvas.redo();
      else this.canvas.undo();
      return;
    }

    if ((event.key === 'Backspace' || event.key === 'Delete') && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      this.deleteSelection();
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const key = event.key.toLowerCase();
    if (key === 'v') this.tools.setTool('select');
    else if (key === 'h') this.tools.setTool('hand');
  }

  @HostListener('window:keyup', ['$event'])
  onWindowKeyUp(event: KeyboardEvent): void {
    if (event.code === 'Space') this.tools.setSpaceHeld(false);
  }

  private isTypingTarget(event: KeyboardEvent): boolean {
    const el = event.target as HTMLElement | null;
    return el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable === true;
  }

  setTool(tool: 'select' | 'hand'): void {
    this.tools.setTool(tool);
  }

  /** Deletes whatever's selected. Deleting every member of a group takes the group with it —
   *  there's no separate "select the group" affordance, so this is also how a group gets removed. */
  private deleteSelection(): void {
    const ids = [...this.canvas.selectedNodeIds()];
    if (ids.length === 0) return;

    this.canvas.snapshot();
    ids.forEach(id => this.canvas.deleteNode(id));

    this.msg.add({
      severity: 'success',
      summary: ids.length === 1 ? 'Node deleted' : `${ids.length} nodes deleted`,
      life: 5000,
      data: { undo: () => this.canvas.undo() },
    });
  }

  // ── Node event handlers ───────────────────────────────────────────────────

  onNodeDragStart(e: { event: MouseEvent; nodeId: string }): void {
    this.dragMode = null;
    this.canvas.snapshot();
    this.draggingNodeId.set(e.nodeId);
    this.dragStartMouse = { x: e.event.clientX, y: e.event.clientY };

    const selected = this.canvas.selectedNodeIds();
    const idsToMove = selected.has(e.nodeId) && selected.size > 1 ? [...selected] : [e.nodeId];
    this.dragGroupStartPositions = new Map(
      idsToMove.map(id => {
        const n = this.canvas.getNode(id)!;
        return [id, { x: n.x, y: n.y }] as const;
      })
    );
  }

  onConnectionPortDown(e: { event: MouseEvent; nodeId: string; side: NodeSide }): void {
    this.dragMode = null;
    const node = this.canvas.getNode(e.nodeId)!;
    const { x, y } = sidePoint(node, e.side, this.sizeOf(e.nodeId));
    this.pendingConn.set({ fromId: e.nodeId, fromKind: 'node', fromSide: e.side, worldX: x, worldY: y });
  }

  onGroupPortDown(e: { event: MouseEvent; groupId: string; side: NodeSide }): void {
    e.event.stopPropagation();
    e.event.preventDefault();
    this.dragMode = null;
    const group = this.groupBounds().find(g => g.id === e.groupId);
    if (!group) return;
    const { x, y } = sidePoint(group, e.side, { width: group.width, height: group.height });
    this.pendingConn.set({ fromId: e.groupId, fromKind: 'group', fromSide: e.side, worldX: x, worldY: y });
  }

  /** Dragging a group's header moves every node in it together, the same mechanism a multi-node selection drag uses. */
  onGroupHeaderMouseDown(event: MouseEvent, groupId: string): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    this.dragMode = null;
    this.canvas.snapshot();
    this.draggingNodeId.set(groupId);
    this.dragStartMouse = { x: event.clientX, y: event.clientY };

    const members = this.canvas.nodes().filter(n => n.groupId === groupId);
    this.dragGroupStartPositions = new Map(members.map(n => [n.id, { x: n.x, y: n.y }] as const));
  }

  onEndpointDragStart(e: { connId: string; end: 'from' | 'to'; event: MouseEvent }): void {
    this.dragMode = null;
    this.reconnecting.set({ connId: e.connId, end: e.end, worldX: this.mouseWorld.x, worldY: this.mouseWorld.y });
  }

  onNodeContextMenu(e: { event: MouseEvent; nodeId: string }): void {
    const node = this.canvas.getNode(e.nodeId);
    if (!node) return;

    const selected = this.canvas.selectedNodeIds();
    const isBulk = selected.has(e.nodeId) && selected.size > 1;

    this.contextMenuItems = isBulk
      ? this.buildBulkContextMenu([...selected])
      : this.buildSingleContextMenu(e.nodeId, node);

    if (!isBulk) this.canvas.selectOnly(e.nodeId);

    this.ctxMenu.show(e.event);
  }

  onGroupContextMenu(event: MouseEvent, groupId: string): void {
    event.preventDefault();
    const memberIds = this.canvas.nodes().filter(n => n.groupId === groupId).map(n => n.id);

    this.contextMenuItems = [
      { label: 'Rename', icon: 'pi pi-pencil', command: () => this.startRenameGroup(groupId) },
      {
        label: 'Ungroup',
        icon: 'pi pi-th-large',
        command: () => { this.canvas.snapshot(); memberIds.forEach(id => this.canvas.ungroupNode(id)); },
      },
      { separator: true },
      {
        label: 'Delete',
        icon: 'pi pi-trash',
        command: () => { this.canvas.snapshot(); memberIds.forEach(id => this.canvas.deleteNode(id)); },
      },
    ];

    this.ctxMenu.show(event);
  }

  /** Editing is single-node only (title/notes), so it's excluded here — every other
   *  action applies to the whole selection at once. */
  private buildBulkContextMenu(ids: string[]): MenuItem[] {
    const nodes = ids.map(id => this.canvas.getNode(id)).filter((n): n is GrindNode => !!n);
    const allCompleted = nodes.length > 0 && nodes.every(n => n.completed);
    const anyGrouped = nodes.some(n => n.groupId);
    const groupIds = new Set(nodes.map(n => n.groupId).filter((g): g is string => !!g));
    const allAlreadyOneGroup = groupIds.size === 1 && nodes.every(n => n.groupId);

    return [
      {
        label: allCompleted ? 'Mark Incomplete' : 'Mark Complete',
        icon: allCompleted ? 'pi pi-times-circle' : 'pi pi-check-circle',
        // Completing skips any node still gated by an incomplete prereq — marking incomplete is unaffected.
        command: () => {
          this.canvas.snapshot();
          ids.forEach(id => {
            if (!allCompleted && this.canvas.prereqStatus(id).locked) return;
            this.canvas.updateNode(id, { completed: !allCompleted });
          });
        },
      },
      {
        label: 'Duplicate',
        icon: 'pi pi-copy',
        command: () => { this.canvas.snapshot(); ids.forEach(id => this.canvas.duplicateNode(id)); },
      },
      ...(!allAlreadyOneGroup ? [{
        label: 'Group',
        icon: 'pi pi-objects-column',
        command: () => { this.canvas.snapshot(); this.canvas.groupNodesTogether(ids); },
      }] : []),
      ...(anyGrouped ? [{
        label: 'Ungroup',
        icon: 'pi pi-th-large',
        command: () => { this.canvas.snapshot(); ids.forEach(id => this.canvas.ungroupNode(id)); },
      }] : []),
      { separator: true },
      {
        label: 'Delete',
        icon: 'pi pi-trash',
        command: () => { this.canvas.snapshot(); ids.forEach(id => this.canvas.deleteNode(id)); },
      },
    ];
  }

  private buildSingleContextMenu(nodeId: string, node: GrindNode): MenuItem[] {
    const locked = !node.completed && this.canvas.prereqStatus(nodeId).locked;
    return [
      {
        label: node.completed ? 'Mark Incomplete' : 'Mark Complete',
        icon: node.completed ? 'pi pi-times-circle' : 'pi pi-check-circle',
        disabled: locked,
        command: () => this.toggleCompleted(nodeId),
      },
      { label: 'Edit', icon: 'pi pi-pencil', command: () => this.editingNodeId.set(nodeId) },
      {
        label: 'Duplicate',
        icon: 'pi pi-copy',
        command: () => { this.canvas.snapshot(); this.canvas.duplicateNode(nodeId); },
      },
      ...(node.groupId ? [{
        label: 'Ungroup',
        icon: 'pi pi-th-large',
        command: () => { this.canvas.snapshot(); this.canvas.ungroupNode(nodeId); },
      }] : []),
      { separator: true },
      {
        label: 'Delete',
        icon: 'pi pi-trash',
        command: () => { this.canvas.snapshot(); this.canvas.deleteNode(nodeId); },
      },
    ];
  }

  // ── Toolbar actions ────────────────────────────────────────────────────────

  addNode(): void {
    const wx = (window.innerWidth / 2 - this.panX()) / this.zoom();
    const wy = (window.innerHeight / 2 - this.panY()) / this.zoom();
    this.canvas.snapshot();
    const id = this.canvas.addNode(wx - NODE_WIDTH / 2, wy - NODE_HEIGHT / 2);
    this.editingNodeId.set(id);
  }

  resetView(): void {
    this.panX.set(0);
    this.panY.set(0);
    this.zoom.set(1);
  }

  zoomIn(): void {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const nz = Math.min(4, this.zoom() * 1.2);
    this.panX.set(cx - (cx - this.panX()) * (nz / this.zoom()));
    this.panY.set(cy - (cy - this.panY()) * (nz / this.zoom()));
    this.zoom.set(nz);
  }

  zoomOut(): void {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const nz = Math.max(0.08, this.zoom() / 1.2);
    this.panX.set(cx - (cx - this.panX()) * (nz / this.zoom()));
    this.panY.set(cy - (cy - this.panY()) * (nz / this.zoom()));
    this.zoom.set(nz);
  }

  toggleCompleted(nodeId: string): void {
    const node = this.canvas.getNode(nodeId);
    if (!node) return;
    if (!node.completed && this.canvas.prereqStatus(nodeId).locked) return;
    this.canvas.snapshot();
    this.canvas.updateNode(nodeId, { completed: !node.completed });
  }

  // Removing the input via *ngIf (on Escape) also blurs it as a side effect, which would
  // otherwise re-trigger commitGroupRename and save the very edit Escape was meant to discard.
  private suppressGroupRenameCommit = false;

  startRenameGroup(groupId: string): void {
    this.editingGroupId.set(groupId);
  }

  commitGroupRename(groupId: string, name: string): void {
    if (this.suppressGroupRenameCommit) {
      this.suppressGroupRenameCommit = false;
      return;
    }
    if (name.trim() !== this.canvas.getGroupName(groupId)) {
      this.canvas.snapshot();
      this.canvas.setGroupName(groupId, name);
    }
    this.editingGroupId.set(null);
  }

  cancelGroupRename(): void {
    this.suppressGroupRenameCommit = true;
    this.editingGroupId.set(null);
  }

  isDraggingNode(nodeId: string): boolean {
    return this.dragGroupStartPositions.has(nodeId);
  }

  /** True once every member of a group is individually locked — a group with at least one
   *  already-unlocked node doesn't get this treatment, since some of it is actionable. */
  isGroupLocked(groupId: string): boolean {
    const members = this.canvas.nodes().filter(n => n.groupId === groupId);
    return members.length > 0 && members.every(n => this.canvas.prereqStatus(n.id).locked);
  }

  trackNode(_: number, node: { id: string }): string {
    return node.id;
  }

  trackGroup(_: number, group: { id: string }): string {
    return group.id;
  }
}
