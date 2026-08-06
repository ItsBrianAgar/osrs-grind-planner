import { Component, inject, Input, Output, EventEmitter } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { ToggleSwitchModule, ToggleSwitchChangeEvent } from 'primeng/toggleswitch';
import { SettingsService, NodeStyle } from '../../services/settings.service';

interface StyleOption {
  id: NodeStyle;
  label: string;
  description: string;
}

@Component({
  selector: 'app-settings-dialog',
  standalone: true,
  imports: [NgFor, NgIf, FormsModule, DialogModule, ButtonModule, ToggleSwitchModule],
  templateUrl: './settings-dialog.component.html',
  styleUrl: './settings-dialog.component.scss',
})
export class SettingsDialogComponent {
  @Input() visible = false;
  @Output() visibleChange = new EventEmitter<boolean>();

  readonly settings = inject(SettingsService);

  readonly styles: StyleOption[] = [
    {
      id: 'border',
      label: 'Left Border',
      description: 'Colour strip on the left edge. Scannable at any zoom.',
    },
    {
      id: 'tint',
      label: 'Tinted Background',
      description: 'Subtle colour wash across the whole card.',
    },
    {
      id: 'ribbon',
      label: 'Top Ribbon',
      description: 'Full-width label pinned to the top of each card.',
    },
  ];

  select(style: NodeStyle): void {
    this.settings.setNodeStyle(style);
  }

  toggleCategories(event: ToggleSwitchChangeEvent): void {
    this.settings.setCategoriesEnabled(event.checked);
  }

  togglePrereqs(event: ToggleSwitchChangeEvent): void {
    this.settings.setPrereqsEnabled(event.checked);
  }

  close(): void {
    this.visibleChange.emit(false);
  }
}
