import { Component, ElementRef, HostListener, computed, effect, inject, signal, untracked, ViewChild } from '@angular/core';
import { NgFor, NgIf, DecimalPipe } from '@angular/common';
import { CanvasService } from '../../services/canvas.service';
import { NodeMetricsService } from '../../services/node-metrics.service';
import { ToolService } from '../../services/tool.service';
import { SettingsService } from '../../services/settings.service';
import { Box, Point, sidePoint, nearestSide, sideFacing, sampleBezier, curveCrossings, bezierPath, distanceToPolyline, OPPOSITE_SIDE, Size } from '../../utils/node-geometry';
import { GrindNodeComponent } from '../grind-node/grind-node.component';
import { ConnectionsLayerComponent, PendingConnection, ReconnectingEnd, SplicePreview } from '../connections-layer/connections-layer.component';
import { NodeEditorComponent } from '../node-editor/node-editor.component';
import { SettingsDialogComponent } from '../settings-dialog/settings-dialog.component';
import { BoardsPanelComponent } from '../boards-panel/boards-panel.component';
import { GrindNode, NODE_WIDTH, NODE_HEIGHT, GROUP_PADDING, GROUP_PADDING_BOTTOM, GROUP_HEADER_HEIGHT, IN_GAME_GROUP_HEADER_HEIGHT, IN_GAME_GROUP_PADDING_BOTTOM, NodeSide } from '../../models/grind-node.model';
import { EndpointKind, NodeConnection } from '../../models/connection.model';
import { GroupBound } from '../../models/group.model';
import { ButtonModule } from 'primeng/button';
import { Toast, ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { ContextMenu, ContextMenuModule } from 'primeng/contextmenu';
import { MenuItem, MessageService, ToastMessageOptions } from 'primeng/api';
import { AutofocusSelectDirective } from '../../directives/autofocus-select.directive';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How long the cursor must stay outside a just-dragged group before its "Drag to move" tooltip can show again. */
const GROUP_TOOLTIP_WAKE_MS = 1000;
/** How far inside a dragged box a connection's curve must pass to count as "dropped onto". */
const SPLICE_HIT_INSET = 12;
/** On-screen px the dragged unit's center can move from where an insert engaged before it's
 *  declined — roughly a third of a node card's width at 100%, so it takes a deliberate pull. */
const SPLICE_CANCEL_RADIUS = 80;
/** How long the dragged unit has to stay on a line before dropping will insert it — long enough
 *  that dragging across lines on the way somewhere else never splices by accident. */
const SPLICE_DWELL_MS = 500;
/** Grace period on a line before the charge visuals start (and the dwell clock with them), so
 *  quickly sweeping across lines doesn't flash blue on each one. Arms after delay + dwell. */
const SPLICE_CHARGE_DELAY_MS = 100;
/** On-screen px another line must be closer to the cursor than the current one before the
 *  target switches to it — keeps near-ties between parallel lines from flip-flopping. */
const SPLICE_SWITCH_MARGIN = 16;
/** On-screen px the cursor must be within of a line for it to be eligible at all — the unit
 *  overlapping a line isn't enough, the user has to be aiming at it. */
const SPLICE_CURSOR_RADIUS = 40;
/** The line already charging/armed stays eligible out to this, so a cursor hovering right at
 *  SPLICE_CURSOR_RADIUS doesn't flicker it in and out (each flicker would restart the hold). */
const SPLICE_CURSOR_RADIUS_KEEP = 56;

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
    BoardsPanelComponent,
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
  private readonly settings = inject(SettingsService);

  @ViewChild('ctxMenu') ctxMenu!: ContextMenu;
  @ViewChild(Toast) toast!: Toast;
  @ViewChild('viewport') viewportRef!: ElementRef<HTMLElement>;

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
  /** What's being dragged as one unit — a lone node, or a whole group via its header. Null for a
   *  multi-node selection drag, which can neither be grouped-by-drop nor spliced into a connection. */
  private readonly dragUnit = signal<ConnTarget | null>(null);
  /** Connection the dragged unit is currently engaged with — dropping inserts the unit into it. */
  readonly spliceTargetConnId = signal<string | null>(null);
  /** The unit's center (world space) when it was last on the engaged line — the cancel radius is centered here. */
  readonly spliceEngage = signal<{ connId: string; x: number; y: number } | null>(null);
  /** A line the unit is currently over but hasn't held on long enough to arm yet — dropping now does nothing. */
  readonly spliceCandidateId = signal<string | null>(null);
  private spliceDwellTimer: ReturnType<typeof setTimeout> | undefined;

  // Panning / marquee-select state — mutually exclusive, chosen by the active tool at mousedown
  private readonly dragMode = signal<'pan' | 'marquee' | null>(null);
  private panStartMouse = { x: 0, y: 0 };
  private panStartValue = { x: 0, y: 0 };
  private marqueeStart = { x: 0, y: 0 };
  readonly marqueeRect = signal<Rect | null>(null);

  // Connection drawing state
  readonly pendingConn = signal<PendingConnection | null>(null);
  readonly reconnecting = signal<ReconnectingEnd | null>(null);

  // Mouse world position (for hit tests)
  private mouseWorld = { x: 0, y: 0 };
  /** Whether the cursor is over the canvas — paste lands at the cursor when it is, else the view's center. */
  mouseInViewport = false;

  // Derived highlight states
  readonly groupDropTargetId = signal<string | null>(null);
  readonly connTarget = signal<ConnTarget | null>(null);

  // Editor
  readonly editingNodeId = signal<string | null>(null);
  readonly editingGroupId = signal<string | null>(null);

  // Settings
  readonly settingsVisible = signal(false);

  // "Drag to move" tooltip on group headers. While anything is being dragged, the canvas moves
  // under the cursor (or the cursor moves with the group), so the label keeps sliding in and out
  // from under it and the tooltip would flicker on and off — so it's off for every drag. A group
  // that was just dragged stays quiet until the cursor has been outside it for a full second,
  // rather than popping up again the moment the drag ends with the cursor still on its header.
  readonly anyDragActive = computed(() =>
    !!this.draggingNodeId() || !!this.dragMode() || !!this.pendingConn() || !!this.reconnecting()
  );
  private readonly groupTooltipSnoozedId = signal<string | null>(null);
  private groupTooltipWakeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    // Warn once each time saving starts failing (not on every failed write while it keeps failing).
    effect(() => {
      const error = this.canvas.saveError();
      if (error) untracked(() => this.msg.add({ severity: 'error', summary: 'Not saved', detail: error, sticky: true }));
    });

    // Opening a board returns to where it was last left (or the default view for a new one),
    // and drops any in-progress gesture or inline rename, which belonged to the previous board.
    effect(() => {
      this.canvas.activeBoardId();
      untracked(() => {
        const view = this.canvas.activeBoard().view;
        this.panX.set(view?.panX ?? 0);
        this.panY.set(view?.panY ?? 0);
        this.zoom.set(view?.zoom ?? 1);
        this.editingGroupId.set(null);
        this.resetGestures();
      });
    });

    // Remember each board's view, debounced so panning doesn't rewrite the board list every
    // frame. The board id is captured when the change happens, so a write still pending when
    // another board opens lands on the board it belongs to.
    let viewTimer: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      const view = { panX: this.panX(), panY: this.panY(), zoom: this.zoom() };
      const boardId = untracked(() => this.canvas.activeBoardId());
      clearTimeout(viewTimer);
      viewTimer = setTimeout(() => this.canvas.setBoardView(boardId, view), 400);
    });
  }

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

    const inGame = this.settings.theme() === 'in-game';
    const header = inGame ? IN_GAME_GROUP_HEADER_HEIGHT : GROUP_HEADER_HEIGHT;
    const bottom = inGame ? IN_GAME_GROUP_PADDING_BOTTOM : GROUP_PADDING_BOTTOM;
    return [...map.entries()].map(([id, g]) => ({
      id,
      x: g.minX - GROUP_PADDING,
      y: g.minY - header,
      width: g.maxX - g.minX + GROUP_PADDING * 2,
      height: g.maxY - g.minY + bottom + header,
    }));
  });

  // ── Workspace-level mouse handlers ───────────────────────────────────────

  onViewportMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;

    if (this.tools.effectiveTool() === 'hand') {
      this.dragMode.set('pan');
      this.panStartMouse = { x: event.clientX, y: event.clientY };
      this.panStartValue = { x: this.panX(), y: this.panY() };
    } else {
      this.dragMode.set('marquee');
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
   *  element's own on-screen offset (e.g. the sidebar beside it) — not just pan/zoom. */
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

  /** Points along a connection's curve — the same curve the layer draws — or null if an end is missing. */
  private connCurve(c: NodeConnection): Point[] | null {
    const from = this.resolveTargetBox(c.fromId, c.fromKind);
    const to = this.resolveTargetBox(c.toId, c.toKind);
    if (!from || !to) return null;
    const p1 = sidePoint(from.box, c.fromSide, from.size);
    const p2 = sidePoint(to.box, c.toSide, to.size);
    return sampleBezier(p1, c.fromSide, p2, c.toSide, 32);
  }

  private curvePassesThrough(c: NodeConnection, rect: Rect): boolean {
    return !!this.connCurve(c)?.some(p =>
      p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height
    );
  }

  /**
   * Of several lines the unit could go into, the one passing closest to the cursor — that's the
   * one the user is aiming at. `currentId` (the line already charging/armed) is kept unless
   * another is closer by SPLICE_SWITCH_MARGIN, so near-ties don't flip-flop and restart the hold.
   */
  private closestToCursor(candidates: NodeConnection[], currentId: string | null): NodeConnection | null {
    let best: NodeConnection | null = null;
    let bestDist = Infinity;
    let currentDist = Infinity;
    for (const c of candidates) {
      const curve = this.connCurve(c);
      if (!curve) continue;
      const d = distanceToPolyline(curve, this.mouseWorld);
      if (c.id === currentId) currentDist = d;
      if (d < bestDist) { best = c; bestDist = d; }
    }
    if (currentDist - bestDist <= SPLICE_SWITCH_MARGIN / this.zoom()) {
      return candidates.find(c => c.id === currentId) ?? best;
    }
    return best;
  }

  /**
   * Picks (or keeps) the connection the dragged unit would be inserted into on drop.
   *
   * A connection is eligible ("on the line") while its curve passes through the unit's box (inset a
   * little, so a line merely grazing an edge doesn't count) AND the cursor is within
   * SPLICE_CURSOR_RADIUS of it — overlap alone isn't aiming. Ones the unit is already part of or
   * couldn't join without a self-loop are skipped. With several eligible, the one nearest the
   * cursor wins. The unit has to stay on that line for the charge delay + dwell before the insert
   * arms (see setSpliceCandidate) — until then this returns null.
   *
   * Once armed, the engage point follows the unit for as long as it's on the line (both checks
   * above); after it slips off, the insert stays armed until the unit's center is SPLICE_CANCEL_RADIUS from where it last
   * touched — so it takes a deliberate pull away from the line to decline, not a wobble. Coming
   * back to a declined line just needs re-aiming and a fresh hold, the same as any other line.
   */
  private updateSpliceTarget(): string | null {
    const unit = this.dragUnit();
    const dragged = unit && this.resolveTargetBox(unit.id, unit.kind);
    if (!unit || !dragged || !this.settings.spliceOnDropEnabled()) {
      this.clearSplice();
      return null;
    }
    const center = { x: dragged.box.x + dragged.size.width / 2, y: dragged.box.y + dragged.size.height / 2 };
    const connections = this.canvas.connections();

    const inner: Rect = {
      x: dragged.box.x + SPLICE_HIT_INSET,
      y: dragged.box.y + SPLICE_HIT_INSET,
      width: dragged.size.width - SPLICE_HIT_INSET * 2,
      height: dragged.size.height - SPLICE_HIT_INSET * 2,
    };
    const engaged = this.spliceEngage();
    const currentId = engaged?.connId ?? this.spliceCandidateId();
    const eligible = (c: NodeConnection) => {
      if (this.canvas.isSelfLoop(c.fromId, c.fromKind, unit.id, unit.kind)) return false;
      if (this.canvas.isSelfLoop(unit.id, unit.kind, c.toId, c.toKind)) return false;
      const curve = this.connCurve(c);
      if (!curve) return false;
      const cursorRadius = (c.id === currentId ? SPLICE_CURSOR_RADIUS_KEEP : SPLICE_CURSOR_RADIUS) / this.zoom();
      return distanceToPolyline(curve, this.mouseWorld) <= cursorRadius && this.curvePassesThrough(c, inner);
    };

    const onLine = connections.filter(eligible);
    const armed = engaged && connections.find(c => c.id === engaged.connId);
    if (armed) {
      const onArmed = onLine.includes(armed);
      const withinRadius = Math.hypot(center.x - engaged.x, center.y - engaged.y) <= this.spliceCancelRadiusWorld();
      // The armed line stays in the running while the unit is on it or still inside the cancel radius.
      const pick = this.closestToCursor(onArmed || withinRadius ? [...new Set([armed, ...onLine])] : onLine, armed.id);
      if (pick === armed) {
        if (onArmed) this.spliceEngage.set({ connId: armed.id, x: center.x, y: center.y });
        return armed.id;
      }
      // Either pulled clear (declined), or the cursor moved to a different line — which starts its own hold.
      this.spliceEngage.set(null);
      this.setSpliceCandidate(pick?.id ?? null);
      return null;
    }

    // Not armed: start (or keep) the dwell countdown on the line the cursor is nearest.
    this.setSpliceCandidate(this.closestToCursor(onLine, this.spliceCandidateId())?.id ?? null);
    return null;
  }

  /** Starts the dwell countdown on a newly hovered line (restarting it if the unit moved onto a
   *  different one), or cancels it when the unit leaves the line. Same line → keeps counting. */
  private setSpliceCandidate(connId: string | null): void {
    if (this.spliceCandidateId() === connId) return;
    clearTimeout(this.spliceDwellTimer);
    this.spliceCandidateId.set(connId);
    if (connId) this.spliceDwellTimer = setTimeout(() => this.armSplice(connId), SPLICE_CHARGE_DELAY_MS + SPLICE_DWELL_MS);
  }

  /** The unit held on the line long enough — arm the insert, centered where the unit is now. */
  private armSplice(connId: string): void {
    const unit = this.dragUnit();
    const dragged = unit && this.resolveTargetBox(unit.id, unit.kind);
    if (this.spliceCandidateId() !== connId || !dragged) return;
    this.spliceCandidateId.set(null);
    this.spliceEngage.set({
      connId,
      x: dragged.box.x + dragged.size.width / 2,
      y: dragged.box.y + dragged.size.height / 2,
    });
    this.spliceTargetConnId.set(connId);
  }

  private clearSplice(): void {
    clearTimeout(this.spliceDwellTimer);
    this.spliceCandidateId.set(null);
    this.spliceEngage.set(null);
  }

  /** Places the preview label off the given side of the dragged unit, counter-scaled so it reads the same at any zoom. */
  spliceLabelTransform(sp: SplicePreview): string {
    const offset = { top: '-50%, -100%', bottom: '-50%, 0', right: '0, -50%', left: '-100%, -50%' }[sp.labelSide];
    return `translate(${offset}) scale(${1 / this.zoom()})`;
  }

  /** The cancel radius is a fixed on-screen distance, so convert it into world units at the current zoom. */
  readonly spliceCancelRadiusWorld = computed(() => SPLICE_CANCEL_RADIUS / this.zoom());

  /**
   * How inserting the dragged unit into a connection would rewire it — shared by the live preview
   * and the actual drop, so what's previewed is exactly what happens. The new links attach to the
   * edges the existing curve passes in and out through, so the wire keeps the route it visibly
   * takes across the unit; the original ends keep their own sides.
   */
  private splicePlan(connId: string, unit: ConnTarget) {
    const conn = this.canvas.connections().find(c => c.id === connId);
    const dragged = this.resolveTargetBox(unit.id, unit.kind);
    const from = conn && this.resolveTargetBox(conn.fromId, conn.fromKind);
    const to = conn && this.resolveTargetBox(conn.toId, conn.toKind);
    if (!conn || !dragged || !from || !to) return null;

    const p1 = sidePoint(from.box, conn.fromSide, from.size);
    const p2 = sidePoint(to.box, conn.toSide, to.size);
    const { entry, exit } = curveCrossings(sampleBezier(p1, conn.fromSide, p2, conn.toSide, 96), dragged.box, dragged.size);

    // An end sitting inside the unit's box (or the unit having drifted off the line while still
    // inside the cancel radius) has no crossing — fall back to the side facing that end.
    const inSide = entry ?? sideFacing(dragged.box, dragged.size, p1);
    let outSide = exit ?? sideFacing(dragged.box, dragged.size, p2);
    // Curve dips in and back out the same edge — flow straight through rather than doubling up.
    if (outSide === inSide) outSide = OPPOSITE_SIDE[inSide];

    return { conn, dragged, p1, p2, inSide, outSide };
  }

  /** Live preview of the pending insert: the two links it would create, and where to put the label. */
  readonly splicePreview = computed<SplicePreview | null>(() => {
    const armedId = this.spliceTargetConnId();
    const connId = armedId ?? this.spliceCandidateId();
    const unit = this.dragUnit();
    if (!connId || !unit) return null;
    const plan = this.splicePlan(connId, unit);
    if (!plan) return null;
    const { conn, dragged, p1, p2, inSide, outSide } = plan;
    const inPoint = sidePoint(dragged.box, inSide, dragged.size);
    const outPoint = sidePoint(dragged.box, outSide, dragged.size);

    // Label goes on a side neither new link uses, so it never sits on top of one.
    const labelSide = (['top', 'bottom', 'right', 'left'] as const).find(side => side !== inSide && side !== outSide)!;
    const anchor = sidePoint(dragged.box, labelSide, dragged.size);

    // 0 while on the line, rising to 1 as the unit is pulled out to the cancel radius.
    const eng = armedId ? this.spliceEngage() : null;
    const center = { x: dragged.box.x + dragged.size.width / 2, y: dragged.box.y + dragged.size.height / 2 };
    const cancelProgress = eng ? Math.min(1, Math.hypot(center.x - eng.x, center.y - eng.y) / this.spliceCancelRadiusWorld()) : 0;

    return {
      connId,
      inPath: bezierPath(p1, conn.fromSide, inPoint, inSide),
      outPath: bezierPath(outPoint, outSide, p2, conn.toSide),
      labelX: anchor.x,
      labelY: anchor.y,
      labelSide,
      label: unit.kind === 'group' ? 'Insert group into progression' : 'Insert node into progression',
      cancelProgress,
      armed: !!armedId,
      dwellMs: SPLICE_DWELL_MS,
      chargeDelayMs: SPLICE_CHARGE_DELAY_MS,
    };
  });

  /** The preview as a 0/1-item list, keyed (see trackSplice) on line + armed state, so the label's
   *  charge bar restarts on a new line and its pop-in replays when the insert arms. */
  readonly splicePreviewList = computed(() => {
    const sp = this.splicePreview();
    return sp ? [sp] : [];
  });

  trackSplice(_: number, sp: SplicePreview): string {
    return `${sp.connId}:${sp.armed}`;
  }

  private spliceDraggedInto(connId: string, unit: ConnTarget): void {
    const plan = this.splicePlan(connId, unit);
    if (!plan) return;
    if (this.canvas.spliceIntoConnection(connId, unit.id, unit.kind, plan.inSide, plan.outSide)) {
      this.msg.add({ severity: 'success', summary: 'Inserted', detail: 'Added into the progression', life: 1800 });
    }
  }

  onViewportMouseMove(event: MouseEvent): void {
    this.mouseWorld = this.toWorld(event);
    this.mouseInViewport = true;
    this.updateGroupTooltipSnooze();

    if (this.dragMode() === 'pan') {
      this.panX.set(this.panStartValue.x + event.clientX - this.panStartMouse.x);
      this.panY.set(this.panStartValue.y + event.clientY - this.panStartMouse.y);
    }

    if (this.dragMode() === 'marquee') {
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
      if (this.dragUnit()?.kind === 'node') {
        const target = this.canvas.nodes().find(n =>
          !this.dragGroupStartPositions.has(n.id) &&
          this.mouseWorld.x >= n.x && this.mouseWorld.x <= n.x + this.sizeOf(n.id).width &&
          this.mouseWorld.y >= n.y && this.mouseWorld.y <= n.y + this.sizeOf(n.id).height
        );
        this.groupDropTargetId.set(target?.id ?? null);
      } else {
        this.groupDropTargetId.set(null);
      }

      // Dropping onto another node groups; only otherwise does a line under the unit count.
      if (this.groupDropTargetId()) this.clearSplice();
      this.spliceTargetConnId.set(this.groupDropTargetId() ? null : this.updateSpliceTarget());
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

    const spliceId = this.spliceTargetConnId();
    const unit = this.dragUnit();
    if (spliceId && unit) this.spliceDraggedInto(spliceId, unit);

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

    this.resetGestures();
  }

  /** Ends any drag/marquee/connection gesture without applying it. */
  private resetGestures(): void {
    this.dragMode.set(null);
    this.marqueeRect.set(null);
    this.draggingNodeId.set(null);
    this.dragGroupStartPositions.clear();
    this.dragUnit.set(null);
    this.spliceTargetConnId.set(null);
    this.clearSplice();
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
    // A modal is up (node editor / settings) — keys belong to it, not the canvas behind it. Without
    // this, Backspace with focus on a dialog button would delete the selected node underneath.
    if (this.editingNodeId() || this.settingsVisible()) return;

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

  // Cmd/Ctrl+C / +V go through the browser's copy/paste events rather than keydown, so the nodes
  // travel on the system clipboard — that's what lets them be pasted into another tab or another
  // copy of the app (local dev site → live site). Each only claims the event when it has nodes to
  // copy/paste, so copying and pasting ordinary text still works.

  @HostListener('window:copy', ['$event'])
  onCopy(event: ClipboardEvent): void {
    if (this.isTypingTarget(event) || this.editingNodeId() || this.settingsVisible()) return;
    if (!this.copyNodes(this.canvas.selectedNodeIds(), false)) return;
    const text = this.canvas.clipboardText();
    if (text && event.clipboardData) {
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
    }
  }

  @HostListener('window:paste', ['$event'])
  onPaste(event: ClipboardEvent): void {
    if (this.isTypingTarget(event) || this.editingNodeId() || this.settingsVisible()) return;
    // Text from the system clipboard wins (it may come from another tab); anything that isn't
    // copied nodes is ignored and the last nodes copied in this tab are pasted instead.
    const text = event.clipboardData?.getData('text/plain');
    if (text) this.canvas.loadClipboardText(text);
    if (this.pasteNodes()) event.preventDefault();
  }

  @HostListener('window:keyup', ['$event'])
  onWindowKeyUp(event: KeyboardEvent): void {
    if (event.code === 'Space') this.tools.setSpaceHeld(false);
  }

  private isTypingTarget(event: Event): boolean {
    const el = event.target as HTMLElement | null;
    return el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable === true;
  }

  setTool(tool: 'select' | 'hand'): void {
    this.tools.setTool(tool);
  }

  /** Deletes whatever's selected. Deleting every member of a group takes the group with it —
   *  there's no separate "select the group" affordance, so this is also how a group gets removed. */
  /** Clicking a connection deletes it — one click is easy to do by accident, so it's a proper
   *  undo step with the same Undo toast as deleting nodes. */
  deleteConnection(id: string): void {
    this.canvas.snapshot();
    this.canvas.removeConnection(id);
    this.msg.add({
      severity: 'success',
      summary: 'Connection deleted',
      life: 5000,
      data: { undo: () => this.canvas.undo() },
    });
  }

  /** A toast's Undo button. PrimeNG only hands a close function to *headless* toast templates, not
   *  the #message template used here, so close this one message the same way its own × does. */
  undoFromToast(message: ToastMessageOptions): void {
    message.data.undo();
    const index = this.toast.messages?.indexOf(message) ?? -1;
    if (index >= 0) this.toast.onMessageClose({ index, message });
  }

  /** Shared by Cmd/Ctrl+C and the right-click Copy items. The right-click items also write the
   *  nodes to the system clipboard here (Cmd/Ctrl+C does it in its copy event instead), so they
   *  can be pasted in another tab too. */
  private copyNodes(ids: Iterable<string>, writeSystemClipboard = true): boolean {
    const count = this.canvas.copyNodes(ids);
    if (count === 0) return false;
    const text = this.canvas.clipboardText();
    if (writeSystemClipboard && text) navigator.clipboard?.writeText(text).catch(() => {});
    this.msg.add({
      severity: 'success',
      summary: count === 1 ? 'Copied 1 node' : `Copied ${count} nodes`,
      detail: 'Paste with ⌘V / Ctrl+V — on this board or another',
      life: 2500,
    });
    return true;
  }

  /** Reads the system clipboard's text, or null if it can't. With mayPrompt false, only reads
   *  when the browser has already granted permission, so it never pops up a prompt. */
  private async readSystemClipboard(mayPrompt: boolean): Promise<string | null> {
    try {
      if (!navigator.clipboard?.readText) return null;
      if (!mayPrompt) {
        const status = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName });
        if (status.state !== 'granted') return null;
      }
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  }

  /** At the cursor if it's over the canvas, otherwise the middle of the view. One undo step. */
  private pasteNodes(): boolean {
    const c = this.viewportCenter();
    const at = this.mouseInViewport
      ? this.mouseWorld
      : { x: (c.x - this.panX()) / this.zoom(), y: (c.y - this.panY()) / this.zoom() };
    if (this.canvas.clipboardSize() === 0) return false;
    this.canvas.snapshot();
    return this.canvas.pasteNodes(at.x, at.y).length > 0;
  }

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
    this.dragMode.set(null);
    this.canvas.snapshot();
    this.draggingNodeId.set(e.nodeId);
    this.dragStartMouse = { x: e.event.clientX, y: e.event.clientY };

    const selected = this.canvas.selectedNodeIds();
    const idsToMove = selected.has(e.nodeId) && selected.size > 1 ? [...selected] : [e.nodeId];
    this.dragUnit.set(idsToMove.length === 1 ? { id: e.nodeId, kind: 'node' } : null);
    this.dragGroupStartPositions = new Map(
      idsToMove.map(id => {
        const n = this.canvas.getNode(id)!;
        return [id, { x: n.x, y: n.y }] as const;
      })
    );
  }

  onConnectionPortDown(e: { event: MouseEvent; nodeId: string; side: NodeSide }): void {
    this.dragMode.set(null);
    const node = this.canvas.getNode(e.nodeId)!;
    const { x, y } = sidePoint(node, e.side, this.sizeOf(e.nodeId));
    this.pendingConn.set({ fromId: e.nodeId, fromKind: 'node', fromSide: e.side, worldX: x, worldY: y });
  }

  onGroupPortDown(e: { event: MouseEvent; groupId: string; side: NodeSide }): void {
    e.event.stopPropagation();
    e.event.preventDefault();
    this.dragMode.set(null);
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
    clearTimeout(this.groupTooltipWakeTimer);
    this.groupTooltipWakeTimer = undefined;
    this.groupTooltipSnoozedId.set(groupId);
    this.dragMode.set(null);
    this.canvas.snapshot();
    this.draggingNodeId.set(groupId);
    this.dragStartMouse = { x: event.clientX, y: event.clientY };

    // Same rule as grabbing a node: if the group is part of a larger selection (it has a selected
    // member, and something outside it is selected too), the whole selection moves with it — as
    // a plain multi-node drag, so it can't be dropped into a connection.
    const memberIds = this.canvas.nodes().filter(n => n.groupId === groupId).map(n => n.id);
    const selected = this.canvas.selectedNodeIds();
    const partOfLargerSelection =
      memberIds.some(id => selected.has(id)) && [...selected].some(id => !memberIds.includes(id));
    const idsToMove = partOfLargerSelection ? [...new Set([...memberIds, ...selected])] : memberIds;
    this.dragUnit.set(partOfLargerSelection ? null : { id: groupId, kind: 'group' });

    this.dragGroupStartPositions = new Map(
      idsToMove.map(id => {
        const n = this.canvas.getNode(id)!;
        return [id, { x: n.x, y: n.y }] as const;
      })
    );
  }

  onEndpointDragStart(e: { connId: string; end: 'from' | 'to'; event: MouseEvent }): void {
    this.dragMode.set(null);
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

  /** Right-click on a connection line: put a new node in the middle of it, or remove it. */
  onConnectionContextMenu(e: { event: MouseEvent; connId: string }): void {
    this.contextMenuItems = [
      { label: 'Insert node', icon: 'pi pi-plus-circle', command: () => this.insertNodeIntoConnection(e.connId) },
      { separator: true },
      { label: 'Unlink', icon: 'pi pi-link', command: () => this.deleteConnection(e.connId) },
    ];
    this.ctxMenu.show(e.event);
  }

  /** A new node centred on the line's midpoint, wired in between the line's two ends
   *  (A → B becomes A → new → B), then opened for editing — one undo step. */
  private insertNodeIntoConnection(connId: string): void {
    const at = this.connectionMidpoint(connId);
    if (!at) return;
    this.canvas.snapshot();
    const id = this.canvas.addNode(Math.round(at.x - NODE_WIDTH / 2), Math.round(at.y - NODE_HEIGHT / 2));
    const plan = this.splicePlan(connId, { id, kind: 'node' });
    if (!plan || !this.canvas.spliceIntoConnection(connId, id, 'node', plan.inSide, plan.outSide)) {
      this.canvas.deleteNode(id);
      return;
    }
    this.canvas.selectOnly(id);
    this.editingNodeId.set(id);
  }

  /** The point halfway along a connection's curve, in world coordinates. */
  private connectionMidpoint(connId: string): { x: number; y: number } | null {
    const conn = this.canvas.connections().find(c => c.id === connId);
    const from = conn && this.resolveTargetBox(conn.fromId, conn.fromKind);
    const to = conn && this.resolveTargetBox(conn.toId, conn.toKind);
    if (!conn || !from || !to) return null;
    const p1 = sidePoint(from.box, conn.fromSide, from.size);
    const p2 = sidePoint(to.box, conn.toSide, to.size);
    return sampleBezier(p1, conn.fromSide, p2, conn.toSide, 2)[1]; // t = 0.5
  }

  /** Right-click on empty canvas. Nodes stop their right-clicks from reaching here and groups
   *  mark theirs handled (defaultPrevented); a text field (group rename) or the bottom tool bar
   *  keeps the browser's own menu. Paste lands where the canvas was clicked. */
  async onCanvasContextMenu(event: MouseEvent): Promise<void> {
    if (event.defaultPrevented) return;
    if ((event.target as HTMLElement).closest('input, textarea, .tool-dock')) return;
    event.preventDefault();

    const at = this.toWorld(event);
    // Pick up nodes copied in another tab — but only if the site may already read the clipboard,
    // since asking for permission on every right-click would be obnoxious.
    const text = await this.readSystemClipboard(false);
    if (text) this.canvas.loadClipboardText(text);
    const count = this.canvas.clipboardSize();
    this.contextMenuItems = [
      ...(count > 0 ? [{
        label: count === 1 ? 'Paste 1 node' : `Paste ${count} nodes`,
        icon: 'pi pi-clipboard',
        command: async () => {
          // A click is a user gesture, so here it's fine for the browser to ask for permission.
          const latest = await this.readSystemClipboard(true);
          if (latest) this.canvas.loadClipboardText(latest);
          this.canvas.snapshot();
          this.canvas.pasteNodes(at.x, at.y);
        },
      }] : []),
      {
        label: 'Reset zoom',
        icon: 'pi pi-search',
        disabled: this.zoom() === 1,
        command: () => this.resetZoom(),
      },
    ];
    this.ctxMenu.show(event);
  }

  onGroupContextMenu(event: MouseEvent, groupId: string): void {
    event.preventDefault();
    const memberIds = this.canvas.nodes().filter(n => n.groupId === groupId).map(n => n.id);

    this.contextMenuItems = [
      { label: 'Rename', icon: 'pi pi-pencil', command: () => this.startRenameGroup(groupId) },
      { label: 'Copy', icon: 'pi pi-clipboard', command: () => this.copyNodes(memberIds) },
      {
        label: 'Duplicate',
        icon: 'pi pi-copy',
        command: () => { this.canvas.snapshot(); this.canvas.duplicateGroup(groupId); },
      },
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
      { label: 'Copy', icon: 'pi pi-clipboard', command: () => this.copyNodes(ids) },
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
      { label: 'Copy', icon: 'pi pi-clipboard', command: () => this.copyNodes([nodeId]) },
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

  // ── Sidebar actions ────────────────────────────────────────────────────────

  /** Center of the viewport in viewport-local px — what pan/zoom are relative to. (Not the window
   *  center: the sidebar offsets the viewport.) */
  private viewportCenter(): Point {
    const el = this.viewportRef?.nativeElement;
    return el ? { x: el.clientWidth / 2, y: el.clientHeight / 2 } : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }

  /** Back to 100%, around the viewport's center — leaves the pan where it is. */
  resetZoom(): void {
    this.setZoomAroundCenter(1);
  }

  zoomIn(): void {
    this.setZoomAroundCenter(this.zoom() * 1.2);
  }

  zoomOut(): void {
    this.setZoomAroundCenter(this.zoom() / 1.2);
  }

  /** Zooms to `z` (clamped to the usual 8%–400%), keeping the viewport's center point fixed. */
  private setZoomAroundCenter(z: number): void {
    const nz = Math.max(0.08, Math.min(4, z));
    const { x: cx, y: cy } = this.viewportCenter();
    this.panX.set(cx - (cx - this.panX()) * (nz / this.zoom()));
    this.panY.set(cy - (cy - this.panY()) * (nz / this.zoom()));
    this.zoom.set(nz);
  }

  /** Applies a typed zoom level ("150", "150%", " 75.5 % "). Anything unparseable is dropped.
   *  The field is rewritten either way, since [value] won't re-render when the zoom (and so the
   *  bound value) ends up unchanged — e.g. typing "abc", or a value that clamps to the current zoom. */
  commitZoomInput(input: HTMLInputElement): void {
    const percent = parseFloat(input.value.replace('%', '').trim());
    if (Number.isFinite(percent) && percent > 0) this.setZoomAroundCenter(percent / 100);
    input.value = `${Math.round(this.zoom() * 100)}%`;
  }

  /** Escape: restore the current zoom, then blur — the blur's commit then re-applies it unchanged. */
  cancelZoomInput(input: HTMLInputElement): void {
    input.value = `${Math.round(this.zoom() * 100)}%`;
    input.blur();
  }

  toggleCompleted(nodeId: string): void {
    const node = this.canvas.getNode(nodeId);
    if (!node) return;
    if (!node.completed && this.canvas.prereqStatus(nodeId).locked) return;
    this.canvas.snapshot();
    this.canvas.updateNode(nodeId, { completed: !node.completed });
  }

  startRenameGroup(groupId: string): void {
    this.editingGroupId.set(groupId);
  }

  /** Called on blur (Enter blurs too). Escape clears editingGroupId first, so if removing the input
   *  then fires a blur — some browsers do, some don't — this sees it's no longer being edited and
   *  ignores it, rather than saving the edit Escape was meant to discard. Nothing lingers either
   *  way, so the next rename always commits. */
  commitGroupRename(groupId: string, name: string): void {
    if (this.editingGroupId() !== groupId) return;
    if (name.trim() !== this.canvas.getGroupName(groupId)) {
      this.canvas.snapshot();
      this.canvas.setGroupName(groupId, name);
    }
    this.editingGroupId.set(null);
  }

  cancelGroupRename(): void {
    this.editingGroupId.set(null);
  }

  /** The node/group being dragged onto a connection once the insert has armed — dropping now inserts it. */
  isSpliceSource(id: string, kind: EndpointKind): boolean {
    const unit = this.dragUnit();
    return !!this.splicePreview()?.armed && unit?.id === id && unit.kind === kind;
  }

  isDraggingNode(nodeId: string): boolean {
    return this.dragGroupStartPositions.has(nodeId);
  }

  isGroupTooltipDisabled(groupId: string): boolean {
    return this.anyDragActive() || this.groupTooltipSnoozedId() === groupId;
  }

  /** Wakes a snoozed group tooltip once the cursor has stayed outside that group for 1s. Called on
   *  every mousemove; `cursorAway` forces "outside" (the cursor left the viewport entirely). */
  updateGroupTooltipSnooze(cursorAway = false): void {
    const groupId = this.groupTooltipSnoozedId();
    if (!groupId || this.draggingNodeId() === groupId) return;
    const g = this.groupBounds().find(b => b.id === groupId);
    const inside = !cursorAway && !!g &&
      this.mouseWorld.x >= g.x && this.mouseWorld.x <= g.x + g.width &&
      this.mouseWorld.y >= g.y && this.mouseWorld.y <= g.y + g.height;
    if (inside) {
      clearTimeout(this.groupTooltipWakeTimer);
      this.groupTooltipWakeTimer = undefined;
    } else if (!this.groupTooltipWakeTimer) {
      this.groupTooltipWakeTimer = setTimeout(() => {
        this.groupTooltipWakeTimer = undefined;
        this.groupTooltipSnoozedId.set(null);
      }, GROUP_TOOLTIP_WAKE_MS);
    }
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
