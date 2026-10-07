// Finds wallets worth following: active traders in liquid, safe tokens, judged on their own history.
import type { ParsedTransactionWithMeta } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { getPriceInfo } from '../prices.ts';
import { MAX_TX_VERSION, connection } from '../solana.ts';
import { BASE_MINTS, SOL_MINT, TRADABLE, USDC_MINT, USDT_MINT, toUi } from '../tokens.ts';
import { getCopySettings } from './copySettings.ts';
import { classifySwap, walletDeltas } from './swapParser.ts';
import { DEFAULT_CRITERIA, scoreWallet, type TradeEvent, type WalletScore } from './walletScore.ts';
import { listWhales, toTxBalances } from './whales.ts';

const JUPITER_API = process.env.JUPITER_API_URL?.trim() || 'https://lite-api.jup.ag';
const REEVALUATE_AFTER_MS = 7 * 86_400_000;

db.exec(`
  CREATE TABLE IF NOT EXISTS whale_candidates (
    address      TEXT PRIMARY KEY,
    found_in     TEXT NOT NULL,     -- token symbols where we saw them trade
    eligible     INTEGER NOT NULL,
    score        REAL NOT NULL,
    stats        TEXT NOT NULL,     -- WalletScore JSON
    evaluated_at INTEGER NOT NULL
  );
`);

export type Candidate = { address: string; foundIn: string[]; score: WalletScore; evaluatedAt: number };

export function recentCandidates(limit = 10): Candidate[] {
  const rows = db.prepare('SELECT * FROM whale_candidates ORDER BY evaluated_at DESC, score DESC LIMIT ?').all(limit) as Record<string, any>[];
  return rows.map((r) => ({ address: r.address, foundIn: JSON.parse(r.found_in), score: JSON.parse(r.stats), evaluatedAt: r.evaluated_at }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Paced for free-tier RPCs (Helius free: ~10 requests/s, shared with whale polling): ~6 tx/s.
const BATCH = 4;
const BATCH_PAUSE_MS = 600;

/** Parsed transactions in small batch requests; falls back to one-by-one if the RPC refuses batches. */
async function fetchParsed(signatures: string[]): Promise<(ParsedTransactionWithMeta | null)[]> {
  const out: (ParsedTransactionWithMeta | null)[] = [];
  for (let i = 0; i < signatures.length; i += BATCH) {
    const chunk = signatures.slice(i, i + BATCH);
    try {
      out.push(...(await connection.getParsedTransactions(chunk, { maxSupportedTransactionVersion: MAX_TX_VERSION })));
    } catch {
      for (const signature of chunk) {
        try {
          out.push(await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: MAX_TX_VERSION }));
        } catch {
          out.push(null);
        }
        await sleep(200);
      }
    }
    await sleep(BATCH_PAUSE_MS);
  }
  return out;
}

type HuntingToken = { mint: string; symbol: string };

/** Where to look for traders: the allowlist plus trending tokens that would pass our safety rules. */
async function huntingTokens(): Promise<HuntingToken[]> {
  const settings = getCopySettings();
  const tokens = new Map<string, HuntingToken>(
    TRADABLE.filter((t) => !BASE_MINTS.has(t.mint)).map((t) => [t.mint, { mint: t.mint, symbol: t.symbol }]),
  );
  for (const list of ['toptrending/24h', 'toptraded/24h']) {
    try {
      const res = await fetch(`${JUPITER_API}/tokens/v2/${list}?limit=30`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      for (const t of (await res.json()) as any[]) {
        const ageHours = t.firstPool?.createdAt ? (Date.now() - Date.parse(t.firstPool.createdAt)) / 3_600_000 : 0;
        if (BASE_MINTS.has(t.id)) continue;
        if ((t.liquidity ?? 0) < settings.minLiquidityUsd) continue;
        if (t.audit?.mintAuthorityDisabled !== true || t.audit?.freezeAuthorityDisabled !== true) continue;
        if (ageHours < settings.minAgeHours) continue;
        tokens.set(t.id, { mint: t.id, symbol: String(t.symbol).replace(/^\$/, '') });
      }
    } catch {
      // Trending lists are a bonus; the allowlist alone still works
    }
  }
  return [...tokens.values()].slice(0, 16);
}

/** Turns one parsed transaction into trade events for whichever signer made a swap in it. */
function tradesIn(tx: ParsedTransactionWithMeta, prices: Map<string, number>, onlyWallet?: string): { wallet: string; events: TradeEvent[] }[] {
  if (!tx.meta || tx.meta.err) return [];
  const balances = toTxBalances(tx);
  const signers = tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey.toBase58());
  const results: { wallet: string; events: TradeEvent[] }[] = [];
  for (const wallet of onlyWallet ? [onlyWallet] : signers) {
    const events: TradeEvent[] = [];
    for (const s of classifySwap(walletDeltas(balances, wallet), prices)) {
      const quotePrice = prices.get(s.quoteMint);
      const tokenPrice = prices.get(s.mint);
      const tokenAmount = toUi(s.tokenRaw, s.decimals);
      const usd = quotePrice !== undefined ? toUi(s.quoteRaw, s.quoteDecimals) * quotePrice : tokenPrice !== undefined ? tokenAmount * tokenPrice : undefined;
      if (usd === undefined || tx.blockTime == null) continue;
      events.push({ time: tx.blockTime, side: s.side, mint: s.mint, tokenAmount, usd });
    }
    if (events.length) results.push({ wallet, events });
    if (events.length && !onlyWallet) break; // first signer that swapped is the trader (others are relayers)
  }
  return results;
}

/** Scores one wallet on its last ~100 transactions. */
export async function evaluateWallet(address: string): Promise<WalletScore> {
  const settings = getCopySettings();
  const sigs = (await connection.getSignaturesForAddress(new PublicKey(address), { limit: 100 })).filter((s) => !s.err).reverse();
  const txs = await fetchParsed(sigs.map((s) => s.signature));
  const baseInfo = await getPriceInfo([SOL_MINT, USDC_MINT, USDT_MINT]);
  const prices = new Map([...baseInfo].map(([m, i]) => [m, i.price]));
  const events = txs.flatMap((tx) => (tx ? tradesIn(tx, prices, address).flatMap((r) => r.events) : []));
  const mints = [...new Set(events.map((e) => e.mint))];
  const info = mints.length ? await getPriceInfo(mints) : new Map();
  return scoreWallet(
    events.sort((a, b) => a.time - b.time),
    (mint) => (info.get(mint)?.liquidity ?? 0) >= settings.minLiquidityUsd,
    DEFAULT_CRITERIA,
  );
}

export type DiscoveryResult = { tokens: string[]; seen: number; evaluated: Candidate[] };

/**
 * 1. Look at recent swaps in liquid tokens and collect who made sizeable trades.
 * 2. Score the busiest of those wallets on their own history.
 * Uses roughly 3,000 RPC calls and ~8 minutes per run (paced for free-tier RPCs).
 */
export async function discoverWhales(maxEvaluate = 15, onProgress?: (text: string) => void): Promise<DiscoveryResult> {
  const settings = getCopySettings();
  const tokens = await huntingTokens();
  const priceInfo = await getPriceInfo([SOL_MINT, USDC_MINT, USDT_MINT, ...tokens.map((t) => t.mint)]);
  const prices = new Map([...priceInfo].map(([m, i]) => [m, i.price]));

  const skip = new Set([
    ...listWhales().map((w) => w.address),
    config.phantomAddress?.toBase58() ?? '',
    ...(db.prepare('SELECT address FROM whale_candidates WHERE evaluated_at > ?').all(Date.now() - REEVALUATE_AFTER_MS) as { address: string }[]).map((r) => r.address),
  ]);

  // Per wallet: biggest trade we saw, and how often it showed up in each token's recent swaps.
  const seen = new Map<string, { count: number; maxUsd: number; perToken: Map<string, number>; tokens: Set<string> }>();
  for (const token of tokens) {
    onProgress?.(`scanning ${token.symbol}`);
    try {
      const sigs = (await connection.getSignaturesForAddress(new PublicKey(token.mint), { limit: 80 })).filter((s) => !s.err);
      for (const tx of await fetchParsed(sigs.map((s) => s.signature))) {
        if (!tx) continue;
        for (const { wallet, events } of tradesIn(tx, prices)) {
          if (skip.has(wallet) || !events.some((e) => e.usd >= settings.minWhaleTradeUsd)) continue;
          const entry = seen.get(wallet) ?? { count: 0, maxUsd: 0, perToken: new Map<string, number>(), tokens: new Set<string>() };
          entry.count++;
          entry.maxUsd = Math.max(entry.maxUsd, ...events.map((e) => e.usd));
          entry.perToken.set(token.symbol, (entry.perToken.get(token.symbol) ?? 0) + 1);
          entry.tokens.add(token.symbol);
          seen.set(wallet, entry);
        }
      }
    } catch (err) {
      console.warn(`Discovery: skipping ${token.symbol}: ${(err as Error).message}`);
    }
  }

  // Bots dominate any token's most recent swaps. A wallet showing up 4+ times in one token's last
  // ~80 swaps is almost certainly one, so skip it, and rank the rest by their biggest trade.
  const BOT_HITS = 4;
  const shortlist = [...seen.entries()]
    .filter(([, e]) => Math.max(...e.perToken.values()) < BOT_HITS)
    .sort((a, b) => b[1].maxUsd - a[1].maxUsd)
    .slice(0, maxEvaluate);
  const evaluated: Candidate[] = [];
  for (const [address, entry] of shortlist) {
    onProgress?.(`evaluating ${address.slice(0, 4)}…`);
    try {
      const score = await evaluateWallet(address);
      const candidate = { address, foundIn: [...entry.tokens], score, evaluatedAt: Date.now() };
      db.prepare(
        `INSERT INTO whale_candidates (address, found_in, eligible, score, stats, evaluated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET found_in = excluded.found_in, eligible = excluded.eligible, score = excluded.score,
           stats = excluded.stats, evaluated_at = excluded.evaluated_at`,
      ).run(address, JSON.stringify(candidate.foundIn), score.eligible ? 1 : 0, score.score, JSON.stringify(score), candidate.evaluatedAt);
      evaluated.push(candidate);
    } catch (err) {
      console.warn(`Discovery: couldn't evaluate ${address}: ${(err as Error).message}`);
    }
  }
  evaluated.sort((a, b) => b.score.score - a.score.score);
  return { tokens: tokens.map((t) => t.symbol), seen: seen.size, evaluated };
}

export function describeScore(s: WalletScore): string {
  return `${s.closed} closed trades, win ${Math.round(s.winRate * 100)}%, return ${s.roiPct >= 0 ? '+' : ''}${s.roiPct.toFixed(1)}%, ` +
    `median hold ${s.medianHoldMin >= 120 ? `${(s.medianHoldMin / 60).toFixed(1)}h` : `${Math.round(s.medianHoldMin)}m`}, ${Math.round(s.tradesPerDay)}/day`;
}
