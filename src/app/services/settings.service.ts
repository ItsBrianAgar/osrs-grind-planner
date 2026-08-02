import { Injectable, signal } from '@angular/core';

export type NodeStyle = 'border' | 'tint' | 'ribbon';

const STORAGE_KEY = 'osrs-node-style';
const CATEGORIES_ENABLED_KEY = 'osrs-categories-enabled';

@Injectable({ providedIn: 'root' })
export class SettingsService {
  readonly nodeStyle = signal<NodeStyle>(
    (localStorage.getItem(STORAGE_KEY) as NodeStyle) ?? 'border'
  );

  /** When disabled, every node is treated as an Item — category picker/badges hide and item-image search applies to all nodes. */
  readonly categoriesEnabled = signal<boolean>(
    localStorage.getItem(CATEGORIES_ENABLED_KEY) !== 'false'
  );

  setNodeStyle(style: NodeStyle): void {
    this.nodeStyle.set(style);
    localStorage.setItem(STORAGE_KEY, style);
  }

  setCategoriesEnabled(enabled: boolean): void {
    this.categoriesEnabled.set(enabled);
    localStorage.setItem(CATEGORIES_ENABLED_KEY, String(enabled));
  }
}
