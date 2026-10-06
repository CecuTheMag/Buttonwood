// ⚠️ Jupiter's base URLs and versions change over time. Check https://dev.jup.ag if quotes start failing.
const JUPITER_API = process.env.JUPITER_API_URL?.trim() || 'https://lite-api.jup.ag';

export type Quote = {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string; // minimum out after slippage
  priceImpactPct: string;
  routePlan: { swapInfo: { label?: string } }[];
};

/** A real mainnet quote: what you'd get right now. Nothing is signed or sent. */
export async function getQuote(inputMint: string, outputMint: string, amountRaw: bigint, slippageBps: number): Promise<Quote> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountRaw.toString(),
    slippageBps: String(slippageBps),
  });
  const res = await fetch(`${JUPITER_API}/swap/v1/quote?${params}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Jupiter quote failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Quote;
}

export const routeLabel = (q: Quote) => [...new Set(q.routePlan.map((r) => r.swapInfo.label).filter(Boolean))].join(' → ') || 'Jupiter';
