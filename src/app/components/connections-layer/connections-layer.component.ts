import { Component, Input, Output, EventEmitter, inject } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import { GrindNode, NodeSide, NODE_WIDTH, NODE_HEIGHT } from '../../models/grind-node.model';
import { EndpointKind, NodeConnection } from '../../models/connection.model';
import { GroupBound } from '../../models/group.model';
import { NodeMetricsService } from '../../services/node-metrics.service';
import { ToolService } from '../../services/tool.service';
import { Box, Point, Size, SIDE_NORMALS, sidePoint } from '../../utils/node-geometry';

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
      </defs>

      <g *ngFor="let conn of connections; trackBy: trackById"
         class="connection-group"
         (mouseenter)="hoveredId = conn.id"
         (mouseleave)="hoveredId = null"
         (click)="removeConnection.emit(conn.id)">
        <ng-container *ngIf="conn.id !== reconnecting?.connId && connGeometry(conn) as geo">
          <path
            [attr.d]="geo.path"
            [attr.stroke]="hoveredId === conn.id ? '#ff6b6b' : '#c8a34a'"
            stroke-width="2"
            fill="none"
            [attr.marker-end]="hoveredId === conn.id ? 'url(#arrowhead-hover)' : 'url(#arrowhead)'"
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
  @Output() removeConnection = new EventEmitter<string>();
  @Output() endpointDragStart = new EventEmitter<{ connId: string; end: 'from' | 'to'; event: MouseEvent }>();

  private readonly metrics = inject(NodeMetricsService);
  readonly tools = inject(ToolService);

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

  connGeometry(conn: NodeConnection): ConnGeometry | null {
    const from = this.resolveBox(conn.fromId, conn.fromKind);
    const to = this.resolveBox(conn.toId, conn.toKind);
    if (!from || !to) return null;

    const fromPoint = sidePoint(from.box, conn.fromSide, from.size);
    const toPoint = sidePoint(to.box, conn.toSide, to.size);

    return { path: this.bezier(fromPoint, conn.fromSide, toPoint, conn.toSide), fromPoint, toPoint };
  }

  getPendingPath(): string | null {
    if (!this.pendingConnection) return null;
    const from = this.resolveBox(this.pendingConnection.fromId, this.pendingConnection.fromKind);
    if (!from) return null;

    const fromPoint = sidePoint(from.box, this.pendingConnection.fromSide, from.size);
    const toPoint = { x: this.pendingConnection.worldX, y: this.pendingConnection.worldY };
    return this.bezier(fromPoint, this.pendingConnection.fromSide, toPoint, null);
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
    return { path: this.bezier(fixedPoint, fixedSide, cursorPoint, null), fixedPoint };
  }

  /** Cubic bezier whose control points pull outward from each side's normal, so the curve always leaves/arrives perpendicular to the node edge. An end with no fixed side (the cursor) just trails toward the other point. */
  private bezier(p1: Point, side1: NodeSide, p2: Point, side2: NodeSide | null): string {
    const dist = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y));
    const offset = Math.max(50, dist * 0.4);
    const n1 = SIDE_NORMALS[side1];

    const c1x = p1.x + n1.x * offset;
    const c1y = p1.y + n1.y * offset;

    let c2x: number, c2y: number;
    if (side2) {
      const n2 = SIDE_NORMALS[side2];
      c2x = p2.x + n2.x * offset;
      c2y = p2.y + n2.y * offset;
    } else {
      c2x = p2.x;
      c2y = p2.y;
    }

    return `M ${p1.x} ${p1.y} C ${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`;
  }
}
