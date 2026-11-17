import { Component, ElementRef, EventEmitter, Output, ViewChild, inject, signal } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import { CdkDrag, CdkDragDrop, CdkDropList } from '@angular/cdk/drag-drop';
import { TooltipModule } from 'primeng/tooltip';
import { Menu, MenuModule } from 'primeng/menu';
import { MenuItem, MessageService } from 'primeng/api';
import { BoardMeta, CanvasService } from '../../services/canvas.service';
import { AutofocusSelectDirective } from '../../directives/autofocus-select.directive';

/** The app's sidebar: a narrow rail with the logo, one letter tile per board (click to open,
 *  double-click to rename, right-click for rename/duplicate/delete, drag to reorder), a "new board" tile, and
 *  settings at the bottom. Renaming pops a small input out beside the tile, since the rail is
 *  too narrow to edit in place. */
@Component({
  selector: 'app-boards-panel',
  standalone: true,
  imports: [NgFor, NgIf, CdkDropList, CdkDrag, TooltipModule, MenuModule, AutofocusSelectDirective],
  templateUrl: './boards-panel.component.html',
  styleUrl: './boards-panel.component.scss',
})
export class BoardsPanelComponent {
  readonly canvas = inject(CanvasService);
  private readonly msg = inject(MessageService);
  private readonly host = inject(ElementRef<HTMLElement>);

  @ViewChild('boardMenu') boardMenu!: Menu;
  @Output() openSettings = new EventEmitter<void>();

  /** Board being renamed, and where its popout input sits (viewport coords, beside the tile). */
  readonly renaming = signal<{ id: string; name: string; left: number; top: number } | null>(null);
  menuItems: MenuItem[] = [];

  /** New boards open straight into rename, since "Board 3" is rarely the name you want. The tile
   *  doesn't exist until the next render, so the rename waits a tick to find it. */
  newBoard(): void {
    const id = this.canvas.createBoard();
    setTimeout(() => this.startRename(id));
  }

  startRename(id: string): void {
    const board = this.canvas.boards().find(b => b.id === id);
    const tile = this.host.nativeElement.querySelector(`[data-board-id="${id}"]`) as HTMLElement | null;
    if (!board || !tile) return;
    tile.scrollIntoView({ block: 'nearest' });
    const rect = tile.getBoundingClientRect();
    this.renaming.set({ id, name: board.name, left: rect.right + 10, top: rect.top + rect.height / 2 });
  }

  openMenu(event: MouseEvent, board: BoardMeta): void {
    event.preventDefault();
    event.stopPropagation();
    const onlyBoard = this.canvas.boards().length <= 1;
    this.menuItems = [
      { label: 'Rename', icon: 'pi pi-pencil', command: () => this.startRename(board.id) },
      { label: 'Duplicate', icon: 'pi pi-clone', command: () => this.canvas.duplicateBoard(board.id) },
      { separator: true },
      {
        label: 'Delete',
        icon: 'pi pi-trash',
        disabled: onlyBoard,
        title: onlyBoard ? 'You need at least one board' : undefined,
        command: () => this.deleteBoard(board),
      },
    ];
    this.boardMenu.show(event);
  }

  private deleteBoard(board: BoardMeta): void {
    const undo = this.canvas.deleteBoard(board.id);
    if (!undo) return;
    this.msg.add({
      severity: 'success',
      summary: 'Board deleted',
      detail: `"${board.name}"`,
      life: 8000,
      data: { undo },
    });
  }

  /** Called on blur (Enter blurs too). Escape clears `renaming` first, so the blur that follows
   *  removing the input is ignored. */
  commitRename(id: string, name: string): void {
    if (this.renaming()?.id !== id) return;
    this.canvas.renameBoard(id, name);
    this.renaming.set(null);
  }

  cancelRename(): void {
    this.renaming.set(null);
  }

  /** First character of a board's name for its tile — whole code point, so a name starting with
   *  an emoji isn't cut in half. */
  initial(name: string): string {
    return ([...name.trim()][0] ?? '?').toUpperCase();
  }

  onBoardDrop(event: CdkDragDrop<BoardMeta[]>): void {
    this.canvas.moveBoard(event.previousIndex, event.currentIndex);
  }

  trackBoard(_: number, b: BoardMeta): string {
    return b.id;
  }
}
