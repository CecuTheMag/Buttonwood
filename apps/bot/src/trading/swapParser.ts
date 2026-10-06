// Pure: turns a wallet's balance changes in one transaction into "bought X" / "sold X" signals.
import { BASE_MINTS, SOL_MINT } from '../tokens.ts';

export type BalanceEntry = { owner?: string; mint: string; amount: string; decimals: number };
export type TxBalances = {
  accountKeys: string[];
  fee?: number;              // lamports, paid by accountKeys[0]: not part of the trade
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: BalanceEntry[];
  postTokenBalances: BalanceEntry[];
};

/** Signed change of one asset for the wallet. SOL = native SOL + wrapped SOL combined. */
export type Delta = { mint: string; raw: bigint; pre: bigint; decimals: number };

export type SwapSignal = {
  side: 'buy' | 'sell';
  mint: string;
  decimals: number;
  tokenRaw: bigint;          // tokens bought / sold
  soldFraction?: number;     // sells: share of the whale's holding that was sold (0–1]
  quoteMint: string;         // what was paid / received (SOL, USDC, USDT, or another token)
  quoteRaw: bigint;
  quoteDecimals: number;
};

export function walletDeltas(tx: TxBalances, wallet: string): Delta[] {
  const byMint = new Map<string, Delta>();
  const add = (mint: string, decimals: number, pre: bigint, post: bigint) => {
    const d = byMint.get(mint) ?? { mint, raw: 0n, pre: 0n, decimals };
    d.raw += post - pre;
    d.pre += pre;
    byMint.set(mint, d);
  };

  const index = tx.accountKeys.indexOf(wallet);
  if (index >= 0) {
    const fee = index === 0 ? BigInt(tx.fee ?? 0) : 0n;
    add(SOL_MINT, 9, BigInt(tx.preBalances[index]), BigInt(tx.postBalances[index]) + fee);
  }

  // Token accounts can be opened (no "pre") or closed (no "post") in the same transaction.
  const key = (e: BalanceEntry) => e.mint;
  const pre = new Map<string, BalanceEntry[]>();
  const post = new Map<string, BalanceEntry[]>();
  for (const e of tx.preTokenBalances) if (e.owner === wallet) pre.set(key(e), [...(pre.get(key(e)) ?? []), e]);
  for (const e of tx.postTokenBalances) if (e.owner === wallet) post.set(key(e), [...(post.get(key(e)) ?? []), e]);
  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    const sum = (list: BalanceEntry[] | undefined) => (list ?? []).reduce((total, e) => total + BigInt(e.amount), 0n);
    const decimals = (pre.get(mint) ?? post.get(mint))![0].decimals;
    add(mint, decimals, sum(pre.get(mint)), sum(post.get(mint)));
  }
  return [...byMint.values()].filter((d) => d.raw !== 0n);
}

const SOL_NOISE = 10_000_000n; // 0.01 SOL: transaction fees and account rent, not a trade

/**
 * Classifies a set of deltas as a swap. Only clean one-in/one-out swaps count;
 * anything else (transfers, liquidity, multi-token mess) is ignored rather than guessed.
 */
export function classifySwap(deltas: Delta[], prices: Map<string, number>, minLegUsd = 1): SwapSignal[] {
  const meaningful = deltas.filter((d) => {
    if (d.mint === SOL_MINT && (d.raw < 0n ? -d.raw : d.raw) < SOL_NOISE) return false;
    const price = prices.get(d.mint);
    if (price !== undefined && Math.abs(Number(d.raw)) / 10 ** d.decimals * price < minLegUsd) return false;
    return true;
  });
  const received = meaningful.filter((d) => d.raw > 0n);
  const spent = meaningful.filter((d) => d.raw < 0n);
  if (received.length !== 1 || spent.length !== 1) return [];
  const [r] = received;
  const [s] = spent;

  const buy = (): SwapSignal => ({ side: 'buy', mint: r.mint, decimals: r.decimals, tokenRaw: r.raw, quoteMint: s.mint, quoteRaw: -s.raw, quoteDecimals: s.decimals });
  const sell = (): SwapSignal => ({
    side: 'sell', mint: s.mint, decimals: s.decimals, tokenRaw: -s.raw,
    soldFraction: s.pre > 0n ? Math.min(1, Number(-s.raw) / Number(s.pre)) : 1,
    quoteMint: r.mint, quoteRaw: r.raw, quoteDecimals: r.decimals,
  });

  const stable = (m: string) => BASE_MINTS.has(m) && m !== SOL_MINT;
  if (!BASE_MINTS.has(r.mint) && BASE_MINTS.has(s.mint)) return [buy()];   // SOL/USDC → token
  if (!BASE_MINTS.has(s.mint) && BASE_MINTS.has(r.mint)) return [sell()];  // token → SOL/USDC
  if (stable(s.mint) && r.mint === SOL_MINT) return [buy()];               // USDC → SOL
  if (s.mint === SOL_MINT && stable(r.mint)) return [sell()];              // SOL → USDC
  if (!BASE_MINTS.has(s.mint) && !BASE_MINTS.has(r.mint)) return [sell(), buy()]; // token → token
  return []; // USDC ↔ USDT etc.
}
