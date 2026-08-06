import { Component, inject, Input, Output, EventEmitter } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { ToggleSwitchModule, ToggleSwitchChangeEvent } from 'primeng/toggleswitch';
import { SettingsService } from '../../services/settings.service';

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

  readonly settings = inject(SettingsService);

  togglePrereqs(event: ToggleSwitchChangeEvent): void {
    this.settings.setPrereqsEnabled(event.checked);
  }

  close(): void {
    this.visibleChange.emit(false);
  }
}
