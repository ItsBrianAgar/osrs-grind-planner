import { CHARGED_SPRITE_MAP } from './chargedSpriteMap.js';

export interface ItemMappingEntry {
  id: number;
  name: string;
}

let cache: ItemMappingEntry[] | null = null;

const RUNELITE_NAMES_URL =
  'https://raw.githubusercontent.com/runelite/static.runelite.net/gh-pages/cache/item/names.json';

function chargedName(name: string): string {
  return name
    .replace(/\s*\(uncharged\)/i, '')
    .replace(/\s*\(inactive\)/i, '')
    .trim();
}

/**
 * Fetches and caches the full searchable item catalog: OSRS Wiki's GE mapping
 * (tradeable items) merged with RuneLite's item name cache (fills in untradeable,
 * quest, and cosmetic items). Charged/uncharged and active/inactive pairs are kept
 * as two separate entries — both remain independently searchable and selectable.
 */
export async function fetchItemMapping(): Promise<ItemMappingEntry[]> {
  if (cache) return cache;

  // No custom headers here: a "User-Agent" header is a non-simple header that forces a
  // CORS preflight, and prices.runescape.wiki's endpoint 400s on preflight — silently
  // breaking the fetch in-browser. Plain requests only need simple/exempt headers.
  const [geRes, rlRes] = await Promise.all([
    fetch('https://prices.runescape.wiki/api/v1/osrs/mapping'),
    fetch(RUNELITE_NAMES_URL),
  ]);

  if (!geRes.ok) throw new Error('Failed to fetch item mapping');

  const geData: Array<{ id: number; name: string }> = await geRes.json();
  const entries: ItemMappingEntry[] = geData.map(e => ({ id: e.id, name: e.name }));
  const existingIds = new Set(entries.map(e => e.id));

  // Inject the charged/active counterpart for items that only appear in their
  // uncharged/inactive form in the GE mapping, so both are independently selectable.
  for (const entry of entries) {
    const chargedId = CHARGED_SPRITE_MAP[entry.id];
    if (chargedId !== undefined && !existingIds.has(chargedId)) {
      entries.push({ id: chargedId, name: chargedName(entry.name) });
      existingIds.add(chargedId);
    }
  }

  // Merge RuneLite names.json — covers non-GE items: cosmetics, untradeable, quest items, etc.
  // GE mapping takes priority; RuneLite fills in the gaps.
  // Noted variants are excluded: same-name dupes from RuneLite are noted/placeholder
  // copies of an item already covered by its unnoted GE entry.
  const existingNames = new Set(entries.map(e => e.name.toLowerCase()));
  if (rlRes.ok) {
    const rlNames: Record<string, string> = await rlRes.json();
    for (const [idStr, name] of Object.entries(rlNames)) {
      const id = parseInt(idStr, 10);
      if (
        !name ||
        name === 'null' ||
        /\(noted\)$/i.test(name) ||
        existingIds.has(id) ||
        existingNames.has(name.toLowerCase())
      ) continue;
      entries.push({ id, name });
      existingIds.add(id);
      existingNames.add(name.toLowerCase());
    }
  }

  cache = entries;
  return cache;
}
