const PRICES_URL = 'https://prices.runescape.wiki/api/v1/osrs/latest';

export type PriceMap = Record<number, { high: number | null; low: number | null }>;

// Module-level cache — fetched once per session
let _cache: PriceMap | null = null;
let _promise: Promise<PriceMap> | null = null;

export async function fetchPrices(): Promise<PriceMap> {
  if (_cache) return _cache;
  if (_promise) return _promise;

  // No custom headers: a "User-Agent" header forces a CORS preflight, and this
  // endpoint 400s on preflight — silently breaking the fetch in-browser.
  _promise = fetch(PRICES_URL)
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((json: { data: Record<string, { high: number | null; low: number | null }> }) => {
      const map: PriceMap = {};
      for (const [id, val] of Object.entries(json.data)) {
        map[parseInt(id, 10)] = val;
      }
      _cache = map;
      _promise = null;
      return map;
    })
    .catch(err => {
      _promise = null;
      throw err;
    });

  return _promise;
}

/** Best available GE price for an item (prefers high, falls back to low). */
export function getPrice(prices: PriceMap | null, itemId: number): number {
  if (!prices) return 0;
  const p = prices[itemId];
  if (!p) return 0;
  return p.high ?? p.low ?? 0;
}

/** Parse a GP shorthand string ("1m", "500k", "1.5b", "250000") into a number. Returns null if unparseable. */
export function parseGp(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/,/g, '');
  if (!s) return null;
  const m = s.match(/^([\d.]+)(k|m|b)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  const mult = m[2] === 'b' ? 1_000_000_000 : m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1_000 : 1;
  return Math.floor(n * mult);
}

/** Format a GP amount the OSRS way: 1.2b, 345.6m, 12.3k, or exact. */
export function formatGp(amount: number): string {
  function trim(s: string) { return s.replace(/\.0$/, ''); }
  if (amount >= 1_000_000_000) return `${trim((amount / 1_000_000_000).toFixed(1))}b gp`;
  if (amount >= 1_000_000) return `${trim((amount / 1_000_000).toFixed(1))}m gp`;
  if (amount >= 1_000) return `${trim((amount / 1_000).toFixed(1))}k gp`;
  return `${amount.toLocaleString()} gp`;
}

/** Same as formatGp but without the " gp" suffix — for use in inputs and compact displays. */
export function formatGpShort(amount: number): string {
  function trim(s: string) { return s.replace(/\.0$/, ''); }
  if (amount >= 1_000_000_000) return `${trim((amount / 1_000_000_000).toFixed(1))}b`;
  if (amount >= 1_000_000) return `${trim((amount / 1_000_000).toFixed(1))}m`;
  if (amount >= 1_000) return `${trim((amount / 1_000).toFixed(1))}k`;
  return amount.toLocaleString();
}
