import { SOL_MINT } from './tokens.ts';

const JUPITER_PRICE_URL = 'https://lite-api.jup.ag/price/v3';

/** USD prices keyed by asset ("SOL" or mint). Returns {} if the price API is down. */
export async function getUsdPrices(assets: string[]): Promise<Record<string, number>> {
  const mints = assets.map((a) => (a === 'SOL' ? SOL_MINT : a));
  const prices: Record<string, number> = {};
  try {
    // The API accepts up to 50 ids per request
    for (let i = 0; i < mints.length; i += 50) {
      const res = await fetch(`${JUPITER_PRICE_URL}?ids=${mints.slice(i, i + 50).join(',')}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`price API ${res.status}`);
      const data = (await res.json()) as Record<string, { usdPrice?: number } | null>;
      for (const [mint, entry] of Object.entries(data)) {
        if (entry?.usdPrice != null) prices[mint === SOL_MINT ? 'SOL' : mint] = entry.usdPrice;
      }
    }
  } catch (err) {
    console.warn('Could not fetch prices:', (err as Error).message);
  }
  return prices;
}

/** Price and pool liquidity (USD) per mint, straight from Jupiter. Missing mints are left out. */
export async function getPriceInfo(mints: string[]): Promise<Map<string, { price: number; liquidity: number }>> {
  const info = new Map<string, { price: number; liquidity: number }>();
  for (let i = 0; i < mints.length; i += 50) {
    const res = await fetch(`${JUPITER_PRICE_URL}?ids=${mints.slice(i, i + 50).join(',')}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`price API ${res.status}`);
    const data = (await res.json()) as Record<string, { usdPrice?: number; liquidity?: number } | null>;
    for (const [mint, entry] of Object.entries(data)) {
      if (entry?.usdPrice != null) info.set(mint, { price: entry.usdPrice, liquidity: entry.liquidity ?? 0 });
    }
  }
  return info;
}
