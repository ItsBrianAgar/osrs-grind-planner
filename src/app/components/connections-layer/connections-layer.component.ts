import { Component, Input, Output, EventEmitter, inject } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import { GrindNode, NodeSide, NODE_WIDTH, NODE_HEIGHT } from '../../models/grind-node.model';
import { EndpointKind, NodeConnection } from '../../models/connection.model';
import { GroupBound } from '../../models/group.model';
import { NodeMetricsService } from '../../services/node-metrics.service';
import { ToolService } from '../../services/tool.service';
import { SettingsService } from '../../services/settings.service';
import { Box, Point, Size, bezierPath, sidePoint } from '../../utils/node-geometry';

export interface ReconnectingEnd {
  connId: string;
  end: 'from' | 'to';
  worldX: number;
  worldY: number;
}

export interface PendingConnection {
  fromId: string;
  fromKind: EndpointKind;
  fromSide: NodeSide;
  worldX: number;
  worldY: number;
}

/** A pending insert of a dragged node/group into connection `connId` — the two replacement links' paths. */
export interface SplicePreview {
  connId: string;
  inPath: string;
  outPath: string;
  labelX: number;
  labelY: number;
  /** Which side of the dragged unit the label sits off — always one the new links don't use. */
  labelSide: NodeSide;
  label: string;
  /** 0 while the unit is on the line, rising to 1 as it's pulled out to the cancel radius. */
  cancelProgress: number;
  /** False while the unit is still holding on the line (charging) — only an armed insert happens on drop. */
  armed: boolean;
  /** How long the charge fill runs — the insert arms the moment it finishes. */
  dwellMs: number;
  /** Pause before the charge visuals start, so sweeping across a line doesn't flash it blue. */
  chargeDelayMs: number;
}

interface ConnGeometry {
  path: string;
  fromPoint: Point;
  toPoint: Point;
}

@Component({
  selector: 'app-connections-layer',
  standalone: true,
  imports: [NgFor, NgIf],
  template: `
    <svg class="connections-svg" [class.tool-hand]="tools.effectiveTool() === 'hand'" width="20000" height="20000" viewBox="-5000 -5000 20000 20000">
      <defs>
        <marker id="arrowhead" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="8" refX="10" refY="4" orient="auto">
          <path d="M 0 0 L 10 4 L 0 8 Z" fill="#c8a34a" />
        </marker>
        <marker id="arrowhead-pending" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="8" refX="10" refY="4" orient="auto">
          <path d="M 0 0 L 10 4 L 0 8 Z" fill="rgba(200,163,74,0.5)" />
        </marker>
        <marker id="arrowhead-hover" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="8" refX="10" refY="4" orient="auto">
          <path d="M 0 0 L 10 4 L 0 8 Z" fill="#ff6b6b" />
        </marker>
        <marker id="arrowhead-splice" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="8" refX="10" refY="4" orient="auto">
          <path d="M 0 0 L 10 4 L 0 8 Z" fill="#60c0ff" />
        </marker>
        <marker id="arrowhead-splice-old" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="8" refX="10" refY="4" orient="auto">
          <path d="M 0 0 L 10 4 L 0 8 Z" fill="rgba(96,192,255,0.4)" />
        </marker>
      </defs>

      <g *ngFor="let conn of connections; trackBy: trackById"
         class="connection-group"
         (mouseenter)="hoveredId = conn.id"
         (mouseleave)="hoveredId = null"
         (click)="removeConnection.emit(conn.id)">
        <ng-container *ngIf="conn.id !== reconnecting?.connId && connGeometry(conn) as geo">
          <path
            [attr.d]="geo.path"
            [class.splice-old]="conn.id === splicePreview?.connId && splicePreview?.armed"
            [attr.stroke]="hoveredId === conn.id ? '#ff6b6b' : '#c8a34a'"
            stroke-width="2"
            fill="none"
            [attr.stroke-dasharray]="isPending(conn) ? '6 4' : null"
            [attr.stroke-opacity]="isPending(conn) ? 0.55 : 1"
            [attr.marker-end]="hoveredId === conn.id ? 'url(#arrowhead-hover)' : conn.id === splicePreview?.connId && splicePreview?.armed ? 'url(#arrowhead-splice-old)' : (isPending(conn) ? 'url(#arrowhead-pending)' : 'url(#arrowhead)')"
          />
          <!-- Hold-to-insert charge: blue fills along the wire from its source over the dwell time. -->
          <path
            *ngIf="conn.id === splicePreview?.connId && !splicePreview?.armed"
            [attr.d]="geo.path"
            class="splice-charge"
            pathLength="1"
            [style.animation-duration.ms]="splicePreview?.dwellMs"
            [style.animation-delay.ms]="splicePreview?.chargeDelayMs"
          />
          <path
            [attr.d]="geo.path"
            stroke="transparent"
            stroke-width="14"
            fill="none"
            [style.pointer-events]="tools.effectiveTool() === 'hand' ? 'none' : 'stroke'"
            style="cursor: pointer;"
          />

          <!-- Endpoint handles: revealed on hover, with a generous invisible grab zone around each visible dot -->
          <ng-container *ngIf="hoveredId === conn.id">
            <g class="endpoint-handle" (mousedown)="onHandleMouseDown($event, conn.id, 'from')" (click)="$event.stopPropagation()">
              <circle [attr.cx]="geo.fromPoint.x" [attr.cy]="geo.fromPoint.y" r="20" class="handle-hitzone" />
              <circle [attr.cx]="geo.fromPoint.x" [attr.cy]="geo.fromPoint.y" r="6" class="handle-dot" />
            </g>
            <g class="endpoint-handle" (mousedown)="onHandleMouseDown($event, conn.id, 'to')" (click)="$event.stopPropagation()">
              <circle [attr.cx]="geo.toPoint.x" [attr.cy]="geo.toPoint.y" r="20" class="handle-hitzone" />
              <circle [attr.cx]="geo.toPoint.x" [attr.cy]="geo.toPoint.y" r="6" class="handle-dot" />
            </g>
          </ng-container>
        </ng-container>
      </g>

      <!-- Insert preview: the two links dropping here would create. Keyed on the target connection so
           switching to a different line replays the draw-in, but moving along the same one doesn't. -->
      <ng-container *ngFor="let sp of splicePreviewList; trackBy: trackSplice">
        <g class="splice-preview" [attr.opacity]="1 - sp.cancelProgress * 0.75">
          <path [attr.d]="sp.inPath" class="splice-glow" />
          <path [attr.d]="sp.outPath" class="splice-glow" />
          <path [attr.d]="sp.inPath" class="splice-new" pathLength="1" marker-end="url(#arrowhead-splice)" />
          <path [attr.d]="sp.outPath" class="splice-new splice-new-out" pathLength="1" marker-end="url(#arrowhead-splice)" />
        </g>
      </ng-container>

      <ng-container *ngIf="pendingConnection">
        <ng-container *ngIf="getPendingPath() as path">
          <path
            [attr.d]="path"
            stroke="rgba(200,163,74,0.55)"
            stroke-width="2"
            fill="none"
            stroke-dasharray="6 4"
            marker-end="url(#arrowhead-pending)"
          />
        </ng-container>
      </ng-container>

      <ng-container *ngIf="reconnecting as rc">
        <ng-container *ngIf="getReconnectPath(rc) as rp">
          <path
            [attr.d]="rp.path"
            stroke="rgba(200,163,74,0.55)"
            stroke-width="2"
            fill="none"
            stroke-dasharray="6 4"
            marker-end="url(#arrowhead-pending)"
          />
          <circle [attr.cx]="rp.fixedPoint.x" [attr.cy]="rp.fixedPoint.y" r="6" class="handle-dot" />
        </ng-container>
      </ng-container>
    </svg>
  `,
  styles: [`
    :host {
      position: absolute;
      left: 0;
      top: 0;
      pointer-events: none;
      z-index: 1;
    }

    .connections-svg {
      position: absolute;
      left: -5000px;
      top: -5000px;
      pointer-events: none;
    }

    .connection-group {
      pointer-events: all;
    }

    .endpoint-handle {
      cursor: grab;
    }

    .handle-hitzone {
      fill: transparent;
      pointer-events: all;
    }

    // Hand tool active: let all mouse interaction pass through to the canvas underneath so
    // click-drag always pans, even when starting on top of a connection/handle.
    .connections-svg.tool-hand .connection-group,
    .connections-svg.tool-hand .handle-hitzone {
      pointer-events: none;
    }

    // Line about to be replaced by an insert: blue, faded, with dashes marching along it.
    .splice-old {
      stroke: #60c0ff;
      stroke-opacity: 0.45;
      stroke-dasharray: 6 5;
      animation: splice-march 600ms linear infinite;
    }

    .splice-charge {
      fill: none;
      stroke: #60c0ff;
      stroke-width: 3;
      stroke-linecap: round;
      stroke-dasharray: 1;
      stroke-dashoffset: 1;
      pointer-events: none;
      // both: stays empty through the delay, and full once done.
      animation: splice-charge-fill linear both;
    }

    @keyframes splice-charge-fill {
      to { stroke-dashoffset: 0; }
    }

    .splice-preview path {
      fill: none;
      pointer-events: none;
    }

    .splice-glow {
      stroke: rgba(96, 192, 255, 0.18);
      stroke-width: 8;
      stroke-linecap: round;
    }

    // pathLength="1" makes a single dash the whole curve, so sliding its offset from 1 → 0 draws it in.
    .splice-new {
      stroke: #60c0ff;
      stroke-width: 2.5;
      stroke-dasharray: 1;
      stroke-dashoffset: 1;
      opacity: 0;
      animation: splice-draw 280ms cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    }

    .splice-new-out {
      animation-delay: 90ms;
    }

    @keyframes splice-draw {
      0% { stroke-dashoffset: 1; opacity: 0; }
      30% { opacity: 1; }
      100% { stroke-dashoffset: 0; opacity: 1; }
    }

    @keyframes splice-march {
      to { stroke-dashoffset: -11; }
    }

    @media (prefers-reduced-motion: reduce) {
      .splice-old { animation: none; }
      .splice-new { animation: none; stroke-dashoffset: 0; opacity: 1; }
      // No sweeping fill — fade in a half-strength blue instead, after the same delay (the label's bar still counts down).
      .splice-charge { animation-name: splice-charge-fade; stroke-dashoffset: 0; stroke-opacity: 0.5; }

      @keyframes splice-charge-fade {
        from { opacity: 0; }
      }
    }

    .handle-dot {
      fill: #ffd700;
      stroke: #1a1710;
      stroke-width: 2;
      pointer-events: none;
    }
  `],
})
export class ConnectionsLayerComponent {
  @Input() connections: NodeConnection[] = [];
  @Input() nodes: GrindNode[] = [];
  @Input() groups: GroupBound[] = [];
  @Input() pendingConnection: PendingConnection | null = null;
  @Input() reconnecting: ReconnectingEnd | null = null;
  /** Pending insert while a node/group is dragged onto a connection. While charging, blue fills
   *  along the line; once armed, the line turns blue and fades, and the two links it would create
   *  draw themselves in. */
  @Input() splicePreview: SplicePreview | null = null;

  get splicePreviewList(): SplicePreview[] {
    return this.splicePreview?.armed ? [this.splicePreview] : [];
  }

  trackSplice(_: number, sp: SplicePreview): string {
    return sp.connId;
  }
  @Output() removeConnection = new EventEmitter<string>();
  @Output() endpointDragStart = new EventEmitter<{ connId: string; end: 'from' | 'to'; event: MouseEvent }>();

  private readonly metrics = inject(NodeMetricsService);
  readonly tools = inject(ToolService);
  private readonly settings = inject(SettingsService);

  hoveredId: string | null = null;

  trackById(_: number, item: { id: string }) {
    return item.id;
  }

  /** Resolves an endpoint (a node or a group id) to its box position + rendered size. */
  private resolveBox(id: string, kind: EndpointKind): { box: Box; size: Size } | null {
    if (kind === 'group') {
      const group = this.groups.find(g => g.id === id);
      return group ? { box: group, size: { width: group.width, height: group.height } } : null;
    }
    const node = this.nodes.find(n => n.id === id);
    if (!node) return null;
    return { box: node, size: this.metrics.get(node.id) ?? { width: NODE_WIDTH, height: NODE_HEIGHT } };
  }

  onHandleMouseDown(event: MouseEvent, connId: string, end: 'from' | 'to'): void {
    event.stopPropagation();
    event.preventDefault();
    this.endpointDragStart.emit({ connId, end, event });
  }

  /** Every connection is a prereq gate: renders dashed/muted while its source isn't satisfied yet,
   *  and snaps solid the moment it is. A group source is satisfied once every member is completed. */
  isPending(conn: NodeConnection): boolean {
    if (!this.settings.prereqsEnabled()) return false;
    if (conn.fromKind === 'node') return !this.nodes.find(n => n.id === conn.fromId)?.completed;
    return !this.nodes.filter(n => n.groupId === conn.fromId).every(n => n.completed);
  }

  connGeometry(conn: NodeConnection): ConnGeometry | null {
    const from = this.resolveBox(conn.fromId, conn.fromKind);
    const to = this.resolveBox(conn.toId, conn.toKind);
    if (!from || !to) return null;

    const fromPoint = sidePoint(from.box, conn.fromSide, from.size);
    const toPoint = sidePoint(to.box, conn.toSide, to.size);

    return { path: bezierPath(fromPoint, conn.fromSide, toPoint, conn.toSide), fromPoint, toPoint };
  }

  getPendingPath(): string | null {
    if (!this.pendingConnection) return null;
    const from = this.resolveBox(this.pendingConnection.fromId, this.pendingConnection.fromKind);
    if (!from) return null;

    const fromPoint = sidePoint(from.box, this.pendingConnection.fromSide, from.size);
    const toPoint = { x: this.pendingConnection.worldX, y: this.pendingConnection.worldY };
    return bezierPath(fromPoint, this.pendingConnection.fromSide, toPoint, null);
  }

  /** While reconnecting, the untouched end stays put at its stored side; the grabbed end trails the cursor. */
  getReconnectPath(rc: ReconnectingEnd): { path: string; fixedPoint: Point } | null {
    const conn = this.connections.find(c => c.id === rc.connId);
    if (!conn) return null;

    const fixedId = rc.end === 'from' ? conn.toId : conn.fromId;
    const fixedKind = rc.end === 'from' ? conn.toKind : conn.fromKind;
    const fixedSide = rc.end === 'from' ? conn.toSide : conn.fromSide;
    const fixed = this.resolveBox(fixedId, fixedKind);
    if (!fixed) return null;

    const fixedPoint = sidePoint(fixed.box, fixedSide, fixed.size);
    const cursorPoint = { x: rc.worldX, y: rc.worldY };
    return { path: bezierPath(fixedPoint, fixedSide, cursorPoint, null), fixedPoint };
  }
}
