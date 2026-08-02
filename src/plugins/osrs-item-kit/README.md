# osrs-item-kit

A self-contained, dependency-free TypeScript data layer for OSRS item search, icons,
and GE prices. No build step, no npm package — copy this folder into any project's
`src/` and import directly.

## Install

Drag the whole `osrs-item-kit` folder into your project (e.g. `src/osrs-item-kit`).
That's it — everything imports by relative path within the folder, and there are no
external runtime dependencies beyond `fetch`.

## Usage

```ts
import { fetchItemMapping, searchItems, spriteUrl, FALLBACK_SPRITE } from './osrs-item-kit';

const mapping = await fetchItemMapping(); // fetch once, cached in memory after that
const results = searchItems(mapping, 'trident of the seas');
// -> [{ id: 11907, name: 'Trident of the seas (uncharged)' },
//     { id: 11905, name: 'Trident of the seas' }]

for (const item of results) {
  console.log(item.name, spriteUrl(item.id));
}
```

```html
<img src={spriteUrl(item.id)} alt={item.name}
     onError={e => { e.currentTarget.src = FALLBACK_SPRITE; }} />
```

```ts
import { fetchPrices, getPrice, formatGp } from './osrs-item-kit';

const prices = await fetchPrices();
formatGp(getPrice(prices, item.id)); // "1.2m gp"
```

## What's included

| Module | Purpose |
|---|---|
| `itemMapping.ts` | `fetchItemMapping()` — merges the OSRS Wiki GE mapping with RuneLite's item name cache into one searchable `{ id, name }[]` catalog. Cached in memory for the session. |
| `search.ts` | `searchItems(mapping, query)` — ranked text search (prefix match > all-words-prefix match > substring match). Every match is followed by its known functional variants (see below), even if the variant's name doesn't match the query text. |
| `spriteUrl.ts` | `spriteUrl(id)` — item icon URL from RuneLite's static CDN. `FALLBACK_SPRITE` is an embedded placeholder data URI for `onError` handlers, so no local asset file is needed. |
| `prices.ts` | `fetchPrices()`, `getPrice()`, `parseGp()`, `formatGp()`, `formatGpShort()` — GE price fetch (OSRS Wiki prices API) and GP formatting/parsing helpers. |
| `chargedSpriteMap.ts` | Table of uncharged/inactive item ids → their charged/active counterpart id. Used by `itemMapping.ts` to inject the counterpart as its own entry. |
| `variantComponents.json` + graph in `search.ts` | Known functional-variant relationships between items: charge states, empty/filled tools, upgraded/combined items (e.g. Amulet of fury + Blood shard → Amulet of rancour). Purely cosmetic ornament-kit recolors are not distinguished from functional ones — this file is the single source of truth for "these ids are variants of each other" and can be extended with more entries as needed. |

## Design notes

- **Both forms of a charge/active pair are independently searchable and selectable.**
  Searching "trident of the seas" returns both the uncharged and charged entries with
  their own id, name, and real icon — nothing is silently collapsed or substituted.
- **No fuzzy-search dependency.** Ranking is a small hand-rolled scoring function; good
  enough for item names, and keeps this kit dependency-free.
- **In-memory caching only.** `fetchItemMapping()` and `fetchPrices()` cache their result
  for the lifetime of the page/process. There's no TTL or persistence — reload to refresh.
- **Framework-agnostic.** No React (or any UI framework) imports. Wire it into whatever
  search box / result list component your project already has.
