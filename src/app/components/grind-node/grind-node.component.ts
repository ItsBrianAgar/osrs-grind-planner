import {
  Component,
  Input,
  Output,
  EventEmitter,
  inject,
  ViewChild,
  ElementRef,
  AfterViewInit,
  OnChanges,
  OnDestroy,
  SimpleChanges,
} from '@angular/core';
import { NgIf } from '@angular/common';
import { GrindNode, NodeSide } from '../../models/grind-node.model';
import { AvatarModule } from 'primeng/avatar';
import { TooltipModule } from 'primeng/tooltip';
import { NodeMetricsService } from '../../services/node-metrics.service';
import { ToolService } from '../../services/tool.service';
import { AvatarTrimService } from '../../services/avatar-trim.service';

@Component({
  selector: 'app-grind-node',
  standalone: true,
  imports: [NgIf, AvatarModule, TooltipModule],
  templateUrl: './grind-node.component.html',
  styleUrl: './grind-node.component.scss',
})
export class GrindNodeComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) node!: GrindNode;
  @Input() isSelected = false;
  @Input() isGroupTarget = false;
  @Input() isDragging = false;
  @Input() isConnTarget = false;
  /** True when this node has at least one incoming connection whose source isn't completed yet. */
  @Input() locked = false;
  @Input() prereqTotal = 0;
  @Input() prereqSatisfied = 0;

  @Output() dragStart = new EventEmitter<{ event: MouseEvent; nodeId: string }>();
  @Output() connectionPortDown = new EventEmitter<{ event: MouseEvent; nodeId: string; side: NodeSide }>();
  @Output() contextMenuRequested = new EventEmitter<{ event: MouseEvent; nodeId: string }>();
  @Output() editRequested = new EventEmitter<string>();
  @Output() selectRequested = new EventEmitter<string>();

  @ViewChild('nodeEl', { static: true }) nodeEl!: ElementRef<HTMLElement>;

  readonly tools = inject(ToolService);
  private readonly metrics = inject(NodeMetricsService);
  private readonly avatarTrim = inject(AvatarTrimService);
  private resizeObserver?: ResizeObserver;

  /** Avatar image actually bound in the template — starts as the raw URL, then swaps to a
   *  padding-trimmed version once that's ready, so the icon centers on its real artwork. */
  displayAvatarUrl = '';
  private lastAvatarUrl?: string;

  ngAfterViewInit(): void {
    this.reportSize();
    this.resizeObserver = new ResizeObserver(() => this.reportSize());
    this.resizeObserver.observe(this.nodeEl.nativeElement);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['node'] && this.node.avatarUrl !== this.lastAvatarUrl) {
      this.lastAvatarUrl = this.node.avatarUrl;
      this.updateAvatar(this.node.avatarUrl);
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.metrics.remove(this.node.id);
  }

  private updateAvatar(url: string | undefined): void {
    if (!url) {
      this.displayAvatarUrl = '';
      return;
    }
    this.displayAvatarUrl = url;
    this.avatarTrim.trim(url).then(trimmed => {
      if (this.node.avatarUrl === url) this.displayAvatarUrl = trimmed;
    });
  }

  private reportSize(): void {
    const el = this.nodeEl.nativeElement;
    this.metrics.set(this.node.id, { width: el.offsetWidth, height: el.offsetHeight });
  }

  get avatarLabel(): string {
    return this.node.title?.charAt(0)?.toUpperCase() ?? '?';
  }

  get cardStyle(): Record<string, string> {
    return {
      left: this.node.x + 'px',
      top: this.node.y + 'px',
      background: '#8b631418',
    };
  }

  onMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    // Don't collapse an existing multi-selection when grabbing one of its already-selected
    // members — that's how dragging the whole group works. Clicking an unselected node still
    // replaces the selection with just that node.
    if (!this.isSelected) this.selectRequested.emit(this.node.id);
    this.dragStart.emit({ event, nodeId: this.node.id });
  }

  onDblClick(event: MouseEvent): void {
    event.stopPropagation();
    this.editRequested.emit(this.node.id);
  }

  onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenuRequested.emit({ event, nodeId: this.node.id });
  }

  onPortMouseDown(event: MouseEvent, side: NodeSide): void {
    event.stopPropagation();
    event.preventDefault();
    this.connectionPortDown.emit({ event, nodeId: this.node.id, side });
  }
}
