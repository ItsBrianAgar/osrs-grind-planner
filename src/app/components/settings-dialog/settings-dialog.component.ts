import { Component, ElementRef, inject, Input, Output, EventEmitter, ViewChild, computed, signal } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { ToggleSwitchModule, ToggleSwitchChangeEvent } from 'primeng/toggleswitch';
import { MultiSelectModule } from 'primeng/multiselect';
import { InputTextModule } from 'primeng/inputtext';
import { spriteUrl } from '../../../plugins/osrs-item-kit/spriteUrl';
import { AutofocusSelectDirective } from '../../directives/autofocus-select.directive';
import { MessageService } from 'primeng/api';
import { SettingsService, Theme } from '../../services/settings.service';
import { CanvasService } from '../../services/canvas.service';

/** "Ironman: Quest cape!" → "ironman-quest-cape", for download file names. */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

@Component({
  selector: 'app-settings-dialog',
  standalone: true,
  imports: [NgFor, NgIf, FormsModule, DialogModule, ButtonModule, ToggleSwitchModule, MultiSelectModule, InputTextModule, AutofocusSelectDirective],
  templateUrl: './settings-dialog.component.html',
  styleUrl: './settings-dialog.component.scss',
})
export class SettingsDialogComponent {
  @Input() visible = false;
  @Output() visibleChange = new EventEmitter<boolean>();
  @ViewChild('importInput') importInput!: ElementRef<HTMLInputElement>;

  readonly settings = inject(SettingsService);
  private readonly canvas = inject(CanvasService);
  private readonly msg = inject(MessageService);

  readonly tabs = [
    { id: 'general', label: 'General', icon: 'pi-cog' },
    { id: 'appearance', label: 'Appearance', icon: 'pi-palette' },
    { id: 'danger', label: 'Danger zone', icon: 'pi-exclamation-triangle' },
  ] as const;
  readonly activeTab = signal<(typeof this.tabs)[number]['id']>('general');
  readonly activeTabLabel = computed(() => this.tabs.find(t => t.id === this.activeTab())!.label);

  // ── Danger zone ──
  // Clearing goes through two confirmations: a yes/no "are you sure?", then typing the word
  // below. Only then is anything deleted — with an Undo on the toast that follows.
  readonly confirmWord = 'Guthix';
  readonly boards = this.canvas.boards;
  /** Boards picked in the "Clear boards" row. */
  boardsToClear: string[] = [];
  /** What's waiting on confirmation, and which of the two steps it's at. Null when not confirming. */
  readonly pendingClear = signal<{ kind: 'boards'; ids: string[]; names: string[] } | { kind: 'all' } | null>(null);
  readonly confirmStep = signal<1 | 2>(1);
  confirmInput = '';

  /** "Clear "Slayer"", "Clear 3 boards", "Clear all data" — names the action in the prompts. */
  readonly pendingClearSummary = computed(() => {
    const p = this.pendingClear();
    if (!p) return '';
    if (p.kind === 'all') return 'every board and everything on them';
    return p.names.length === 1 ? `everything on "${p.names[0]}"` : `everything on ${p.names.length} boards (${p.names.map(n => `"${n}"`).join(', ')})`;
  });

  get confirmWordMatches(): boolean {
    return this.confirmInput.trim().toLowerCase() === this.confirmWord.toLowerCase();
  }

  startClearBoards(): void {
    const ids = this.boardsToClear.filter(id => this.boards().some(b => b.id === id));
    if (ids.length === 0) return;
    const names = ids.map(id => this.boards().find(b => b.id === id)!.name);
    this.beginConfirm({ kind: 'boards', ids, names });
  }

  startClearAll(): void {
    this.beginConfirm({ kind: 'all' });
  }

  private beginConfirm(pending: NonNullable<ReturnType<typeof this.pendingClear>>): void {
    this.confirmInput = '';
    this.confirmStep.set(1);
    this.pendingClear.set(pending);
  }

  /** Step 1's "Yes" — on to typing the word. */
  confirmYes(): void {
    this.confirmStep.set(2);
  }

  cancelClear(): void {
    this.pendingClear.set(null);
    this.confirmInput = '';
  }

  /** Step 2 — only acts if the word was typed correctly. Closes settings so the toast (and its
   *  Undo) isn't behind the dialog. */
  confirmClear(): void {
    const pending = this.pendingClear();
    if (!pending || !this.confirmWordMatches) return;

    const undo = pending.kind === 'all' ? this.canvas.clearAllBoards() : this.canvas.clearBoards(pending.ids);
    this.msg.add({
      severity: 'success',
      summary: pending.kind === 'all' ? 'All data cleared' : pending.names.length === 1 ? 'Board cleared' : `${pending.names.length} boards cleared`,
      detail: pending.kind === 'all'
        ? 'Every board was deleted'
        : `Removed everything on ${pending.names.map(n => `"${n}"`).join(', ')}`,
      life: 10000,
      data: { undo },
    });
    this.boardsToClear = [];
    this.cancelClear();
    this.close();
  }

  /** The Twisted bow's icon, for the sample node in the theme previews. */
  readonly previewItemSprite = spriteUrl(20997);

  readonly themes: { label: string; value: Theme }[] = [
    { label: 'Default', value: 'default' },
    { label: 'In-game', value: 'in-game' },
  ];

  setTheme(theme: Theme): void {
    this.settings.setTheme(theme);
  }

  togglePrereqs(event: ToggleSwitchChangeEvent): void {
    this.settings.setPrereqsEnabled(event.checked);
  }

  toggleSpliceOnDrop(event: ToggleSwitchChangeEvent): void {
    this.settings.setSpliceOnDropEnabled(event.checked);
  }

  exportBoard(): void {
    const snapshot = this.canvas.exportSnapshot();
    this.download(snapshot, `osrs-grind-planner-${slugify(snapshot.name ?? '') || 'board'}`);
  }

  exportAllBoards(): void {
    this.download(this.canvas.exportAllBoards(), 'osrs-grind-planner-all-boards');
  }

  private download(data: unknown, baseName: string): void {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().slice(0, 10);

    const link = document.createElement('a');
    link.href = url;
    link.download = `${baseName}-${date}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  triggerImport(): void {
    this.importInput.nativeElement.click();
  }

  async onImportFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const data = JSON.parse(await file.text());
      const added = this.canvas.importBoards(data, file.name.replace(/\.json$/i, ''));
      this.msg.add({
        severity: 'success',
        summary: added.length === 1 ? 'Board imported' : `${added.length} boards imported`,
        detail: added.length === 1 ? `Added "${added[0].name}"` : `Added from "${file.name}"`,
        life: 5000,
      });
    } catch (err) {
      this.msg.add({
        severity: 'error',
        summary: 'Import failed',
        detail: err instanceof Error ? err.message : 'Could not read that file.',
        life: 5000,
      });
    } finally {
      // Reset so re-selecting the same file still fires a change event.
      input.value = '';
    }
  }

  close(): void {
    this.visibleChange.emit(false);
  }
}
