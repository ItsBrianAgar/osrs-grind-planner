import { Injectable } from '@angular/core';
import {
  fetchItemMapping,
  searchItems,
  spriteUrl,
  FALLBACK_SPRITE,
  type ItemMappingEntry,
} from '../../plugins/osrs-item-kit';

export type { ItemMappingEntry };

@Injectable({ providedIn: 'root' })
export class ItemSearchService {
  private mapping: ItemMappingEntry[] | null = null;
  private mappingPromise: Promise<ItemMappingEntry[]> | null = null;

  /** Ranked OSRS item search by name. Fetches and caches the item catalog on first use. */
  async search(query: string): Promise<ItemMappingEntry[]> {
    const mapping = await this.getMapping();
    return searchItems(mapping, query);
  }

  /** Real item icon URL from RuneLite's static CDN. */
  spriteUrl(itemId: number): string {
    return spriteUrl(itemId);
  }

  readonly fallbackSprite = FALLBACK_SPRITE;

  private getMapping(): Promise<ItemMappingEntry[]> {
    if (this.mapping) return Promise.resolve(this.mapping);
    if (!this.mappingPromise) {
      this.mappingPromise = fetchItemMapping().then(m => {
        this.mapping = m;
        return m;
      });
    }
    return this.mappingPromise;
  }
}
