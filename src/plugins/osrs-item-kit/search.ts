import type { ItemMappingEntry } from './itemMapping.js';
import variantComponentsJson from './variantComponents.json' with { type: 'json' };

interface VariantComponent {
  id: number;
  name: string;
  quantity?: number;
}

const VARIANT_COMPONENTS = variantComponentsJson as Record<string, VariantComponent[]>;

// Bidirectional id -> related-ids graph, built once from the bundled functional-variant
// relationships (charge states, empty/filled tools, upgraded/combined items, etc.).
const variantGraph = new Map<number, Set<number>>();
const fallbackNames = new Map<number, string>();

function link(a: number, b: number) {
  if (!variantGraph.has(a)) variantGraph.set(a, new Set());
  variantGraph.get(a)!.add(b);
}

for (const [resultIdStr, components] of Object.entries(VARIANT_COMPONENTS)) {
  const resultId = Number(resultIdStr);
  for (const c of components) {
    link(resultId, c.id);
    link(c.id, resultId);
    fallbackNames.set(c.id, c.name);
  }
}

function rankByQuery(mapping: ItemMappingEntry[], q: string, qWords: string[]) {
  return mapping
    .map(e => {
      const n = e.name.toLowerCase();
      const nWords = n.split(/\s+/);
      if (n.startsWith(q)) return { e, score: 0 };
      if (qWords.every((qw: string) => nWords.some((nw: string) => nw.startsWith(qw)))) return { e, score: 1 };
      if (n.includes(q)) return { e, score: 2 };
      return null;
    })
    .filter((x): x is { e: ItemMappingEntry; score: number } => x !== null)
    .sort((a, b) => a.score - b.score || a.e.name.localeCompare(b.e.name))
    .map(x => x.e);
}

/**
 * Ranked text search over an item mapping (score: name starts with query, then every
 * query word prefix-matches a name word, then plain substring — ties broken alphabetically).
 *
 * Each match is immediately followed by any known functional variants — charge states,
 * empty/filled forms, upgraded/combined items — from the bundled variant graph, even if
 * the variant's own name doesn't match the query text. This lets a search for e.g.
 * "trident of the seas" surface both the uncharged and charged forms as distinct,
 * independently selectable results.
 */
export function searchItems(mapping: ItemMappingEntry[], query: string): ItemMappingEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const qWords = q.split(/\s+/);

  const entryById = new Map(mapping.map(e => [e.id, e]));
  const resolve = (id: number): ItemMappingEntry | null => {
    const found = entryById.get(id);
    if (found) return found;
    const name = fallbackNames.get(id);
    return name ? { id, name } : null;
  };

  const matches = rankByQuery(mapping, q, qWords);
  const seen = new Set<number>(matches.map(e => e.id));
  const results: ItemMappingEntry[] = [];

  for (const match of matches) {
    results.push(match);
    const relatedIds = variantGraph.get(match.id);
    if (!relatedIds) continue;
    for (const relatedId of relatedIds) {
      if (seen.has(relatedId)) continue;
      const relatedEntry = resolve(relatedId);
      if (!relatedEntry) continue;
      seen.add(relatedId);
      results.push(relatedEntry);
    }
  }

  return results;
}
