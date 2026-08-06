import { Component, ElementRef, inject, Input, Output, EventEmitter, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { ToggleSwitchModule, ToggleSwitchChangeEvent } from 'primeng/toggleswitch';
import { MessageService } from 'primeng/api';
import { SettingsService } from '../../services/settings.service';
import { CanvasService } from '../../services/canvas.service';

@Component({
  selector: 'app-settings-dialog',
  standalone: true,
  imports: [FormsModule, DialogModule, ButtonModule, ToggleSwitchModule],
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

  togglePrereqs(event: ToggleSwitchChangeEvent): void {
    this.settings.setPrereqsEnabled(event.checked);
  }

  exportCanvas(): void {
    const json = JSON.stringify(this.canvas.exportSnapshot(), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().slice(0, 10);

    const link = document.createElement('a');
    link.href = url;
    link.download = `osrs-grind-planner-${date}.json`;
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
      this.canvas.importSnapshot(data);
      this.msg.add({
        severity: 'success',
        summary: 'Canvas imported',
        detail: `Replaced the canvas with "${file.name}"`,
        life: 5000,
        data: { undo: () => this.canvas.undo() },
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
