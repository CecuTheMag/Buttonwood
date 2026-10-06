import { PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { db } from '../db.ts';
import { usd } from '../format.ts';
import { MAX_TX_VERSION, connection } from '../solana.ts';
import { registerToken, toUi, tokenByMint } from '../tokens.ts';
import { getCopySettings } from './copySettings.ts';
import { fetchPrices, formatOutcome, placeOrders, type Outcome } from './engine.ts';
import { transaction } from './store.ts';
import { classifySwap, walletDeltas, type SwapSignal, type TxBalances } from './swapParser.ts';
import { vetToken } from './tokenInfo.ts';
import type { Order } from './types.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS whales (
    address        TEXT PRIMARY KEY,
    label          TEXT NOT NULL,
    enabled        INTEGER NOT NULL DEFAULT 1,
    usd_per_trade  REAL,                       -- null = default copy size
    last_signature TEXT,
    paused_reason  TEXT,
    added_at       INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS whale_positions (  -- the part of each paper position that came from copying a whale
    whale      TEXT NOT NULL,
    mint       TEXT NOT NULL,
    amount_raw TEXT NOT NULL,
    cost_usd   REAL NOT NULL,
    PRIMARY KEY (whale, mint)
  );
  CREATE TABLE IF NOT EXISTS whale_signals (    -- every whale trade we saw and what we did about it
    signature   TEXT NOT NULL,
    whale       TEXT NOT NULL,
    side        TEXT NOT NULL,
    mint        TEXT NOT NULL,
    whale_usd   REAL NOT NULL,
    whale_price REAL,
    block_time  INTEGER,
    action      TEXT NOT NULL,                 -- copied | skipped | ignored
    detail      TEXT NOT NULL,
    delay_sec   REAL,
    slippage_pct REAL,                         -- how much worse our price was than the whale's
    seen_at     INTEGER NOT NULL,
    PRIMARY KEY (signature, mint, side)
  );
`);

export type Whale = {
  address: string;
  label: string;
  enabled: boolean;
  usdPerTrade: number | null;
  lastSignature: string | null;
  pausedReason: string | null;
};

const toWhale = (r: Record<string, any>): Whale => ({
  address: r.address, label: r.label, enabled: r.enabled === 1, usdPerTrade: r.usd_per_trade,
  lastSignature: r.last_signature, pausedReason: r.paused_reason,
});

export const listWhales = () => (db.prepare('SELECT * FROM whales ORDER BY added_at').all() as Record<string, any>[]).map(toWhale);
export const findWhale = (query: string) =>
  listWhales().find((w) => w.address === query || w.label.toLowerCase() === query.toLowerCase());

export function addWhale(address: string, label: string, usdPerTrade: number | null) {
  new PublicKey(address); // throws on an invalid address
  db.prepare(
    `INSERT INTO whales (address, label, usd_per_trade, added_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET label = excluded.label, usd_per_trade = excluded.usd_per_trade, enabled = 1, paused_reason = NULL`,
  ).run(address, label, usdPerTrade, Date.now());
}
export const removeWhale = (address: string) => db.prepare('DELETE FROM whales WHERE address = ?').run(address).changes > 0;
export const setWhaleEnabled = (address: string, enabled: boolean, reason: string | null = null) =>
  db.prepare('UPDATE whales SET enabled = ?, paused_reason = ? WHERE address = ?').run(enabled ? 1 : 0, reason, address);
const setLastSignature = (address: string, signature: string) =>
  db.prepare('UPDATE whales SET last_signature = ? WHERE address = ?').run(signature, address);

type WhalePosition = { whale: string; mint: string; amountRaw: bigint; costUsd: number };
function getWhalePositions(whale?: string): WhalePosition[] {
  const rows = (whale
    ? db.prepare('SELECT * FROM whale_positions WHERE whale = ?').all(whale)
    : db.prepare('SELECT * FROM whale_positions').all()) as Record<string, any>[];
  return rows.map((r) => ({ whale: r.whale, mint: r.mint, amountRaw: BigInt(r.amount_raw), costUsd: r.cost_usd }));
}
function saveWhalePosition(p: WhalePosition) {
  if (p.amountRaw <= 0n) {
    db.prepare('DELETE FROM whale_positions WHERE whale = ? AND mint = ?').run(p.whale, p.mint);
    return;
  }
  db.prepare(
    `INSERT INTO whale_positions (whale, mint, amount_raw, cost_usd) VALUES (?, ?, ?, ?)
     ON CONFLICT(whale, mint) DO UPDATE SET amount_raw = excluded.amount_raw, cost_usd = excluded.cost_usd`,
  ).run(p.whale, p.mint, p.amountRaw.toString(), p.costUsd);
}

function recordSignal(s: {
  signature: string; whale: string; side: string; mint: string; whaleUsd: number; whalePrice: number | null;
  blockTime: number | null; action: 'copied' | 'skipped' | 'ignored'; detail: string; delaySec?: number; slippagePct?: number;
}) {
  db.prepare(
    `INSERT OR IGNORE INTO whale_signals (signature, whale, side, mint, whale_usd, whale_price, block_time, action, detail, delay_sec, slippage_pct, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(s.signature, s.whale, s.side, s.mint, s.whaleUsd, s.whalePrice, s.blockTime, s.action, s.detail, s.delaySec ?? null, s.slippagePct ?? null, Date.now());
}

function toTxBalances(tx: ParsedTransactionWithMeta): TxBalances {
  const entry = (b: NonNullable<NonNullable<ParsedTransactionWithMeta['meta']>['preTokenBalances']>[number]) => ({
    owner: b.owner, mint: b.mint, amount: b.uiTokenAmount.amount, decimals: b.uiTokenAmount.decimals,
  });
  return {
    accountKeys: tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58()),
    fee: tx.meta!.fee,
    preBalances: tx.meta!.preBalances,
    postBalances: tx.meta!.postBalances,
    preTokenBalances: (tx.meta!.preTokenBalances ?? []).map(entry),
    postTokenBalances: (tx.meta!.postTokenBalances ?? []).map(entry),
  };
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const symbolOf = (mint: string) => tokenByMint(mint)?.symbol ?? short(mint);

type Planned = { order: Order; signal: SwapSignal; signature: string; whaleUsd: number; whalePrice: number; blockTime: number | null; delaySec: number };

/**
 * One poll of every enabled whale. Copies fresh trades into the paper account.
 * After downtime, old BUYS are reported but not copied (the moment has passed); SELLS are still copied.
 */
export async function pollWhales(): Promise<string[]> {
  const settings = getCopySettings();
  const messages: string[] = [];

  for (const whale of listWhales().filter((w) => w.enabled)) {
    const owner = new PublicKey(whale.address);
    if (!whale.lastSignature) {
      // New whale: start following from now
      const [latest] = await connection.getSignaturesForAddress(owner, { limit: 1 });
      if (latest) setLastSignature(whale.address, latest.signature);
      continue;
    }

    const signatures = (await connection.getSignaturesForAddress(owner, { until: whale.lastSignature, limit: 25 })).reverse();
    if (signatures.length === 0) continue;

    const planned: Planned[] = [];
    const skipped: string[] = [];
    // One copy per token per whale. Bots and big wallets buy in many small pieces; copying each
    // piece would multiply our position and burn fees. Further buys = the whale adding, not a new signal.
    const holding = new Set(getWhalePositions(whale.address).map((p) => p.mint));
    for (const sig of signatures) {
      const done = () => setLastSignature(whale.address, sig.signature);
      if (sig.err) { done(); continue; }
      let tx;
      try {
        tx = await connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: MAX_TX_VERSION });
      } catch (err) {
        console.warn(`Whale ${whale.label}: skipping unreadable tx ${sig.signature}: ${(err as Error).message}`);
        done();
        continue;
      }
      if (!tx?.meta) { done(); continue; }
      const deltas = walletDeltas(toTxBalances(tx), whale.address);
      if (deltas.length === 0) { done(); continue; }
      const prices = await fetchPrices(deltas.map((d) => d.mint));

      for (const signal of classifySwap(deltas, prices)) {
        registerToken({ mint: signal.mint, symbol: symbolOf(signal.mint), decimals: signal.decimals });
        const quoteUsd = toUi(signal.quoteRaw, signal.quoteDecimals) * (prices.get(signal.quoteMint) ?? 0);
        const tokenAmount = toUi(signal.tokenRaw, signal.decimals);
        const whaleUsd = quoteUsd || tokenAmount * (prices.get(signal.mint) ?? 0);
        const whalePrice = tokenAmount > 0 && quoteUsd > 0 ? quoteUsd / tokenAmount : prices.get(signal.mint) ?? 0;
        const delaySec = sig.blockTime ? Date.now() / 1000 - sig.blockTime : 0;
        const base = { signature: sig.signature, whale: whale.address, side: signal.side, mint: signal.mint, whaleUsd, whalePrice, blockTime: sig.blockTime ?? null };

        if (whaleUsd < settings.minWhaleTradeUsd) {
          recordSignal({ ...base, action: 'ignored', detail: `small trade (${usd(whaleUsd)})` });
          continue;
        }

        if (signal.side === 'buy') {
          if (holding.has(signal.mint)) {
            recordSignal({ ...base, action: 'ignored', detail: 'already holding a copy (whale adding to position)', delaySec });
            continue;
          }
          if (delaySec > settings.maxCopyDelaySec) {
            recordSignal({ ...base, action: 'skipped', detail: `seen ${Math.round(delaySec)}s late`, delaySec });
            skipped.push(`• bought ${usd(whaleUsd)} of ${symbolOf(signal.mint)} ${Math.round(delaySec / 60)} min ago: too late to copy`);
            continue;
          }
          const verdict = await vetToken(signal.mint, settings);
          if (!verdict.safe) {
            recordSignal({ ...base, action: 'skipped', detail: `unsafe: ${verdict.reason}`, delaySec });
            skipped.push(`• bought ${usd(whaleUsd)} of ${verdict.symbol}: ⚠️ not copied (${verdict.reason})`);
            continue;
          }
          const token = tokenByMint(signal.mint)!;
          holding.add(signal.mint);
          planned.push({
            ...base, signal, delaySec,
            order: {
              side: 'buy', token, amount: whale.usdPerTrade ?? settings.usdPerTrade, strategyId: null, whale: whale.address, vetted: true,
              reason: `Copying ${whale.label}: they bought ${usd(whaleUsd)} of ${token.symbol} ${Math.round(delaySec)}s earlier`,
            },
          });
        } else {
          const held = getWhalePositions(whale.address).find((p) => p.mint === signal.mint);
          if (!held) {
            recordSignal({ ...base, action: 'ignored', detail: 'not holding a copy', delaySec });
            continue;
          }
          const fraction = signal.soldFraction ?? 1;
          const sellRaw = fraction >= 0.95 ? held.amountRaw : BigInt(Math.floor(Number(held.amountRaw) * fraction));
          const token = tokenByMint(signal.mint)!;
          planned.push({
            ...base, signal, delaySec,
            order: {
              side: 'sell', token, amount: 1, sellRaw, strategyId: null, whale: whale.address,
              reason: `Copying ${whale.label}: they sold ${Math.round(fraction * 100)}% of their ${token.symbol}`,
            },
          });
        }
      }
      done();
    }

    if (skipped.length) messages.push(`🐋 ${whale.label} traded:\n${skipped.join('\n')}`);
    if (planned.length) messages.push(...applyCopies(whale, planned, await placeOrders(planned.map((p) => p.order))));
  }

  messages.push(...(await enforceCopyStopLoss()));
  messages.push(...autoPauseLosingWhales());
  return messages;
}

/** Book the results: per-whale positions, delay and slippage vs the whale's own price. */
function applyCopies(whale: Whale, planned: Planned[], outcomes: Outcome[]): string[] {
  const messages: string[] = [];
  planned.forEach((p, i) => {
    const outcome = outcomes[i];
    const base = { signature: p.signature, whale: whale.address, side: p.signal.side, mint: p.signal.mint, whaleUsd: p.whaleUsd, whalePrice: p.whalePrice, blockTime: p.blockTime, delaySec: p.delaySec };
    if (!outcome.ok) {
      recordSignal({ ...base, action: 'skipped', detail: outcome.reason });
      if (outcome.reason.startsWith("you don't hold")) saveWhalePosition({ whale: whale.address, mint: p.signal.mint, amountRaw: 0n, costUsd: 0 });
      messages.push(`🐋 ${formatOutcome(outcome)}`);
      return;
    }
    // Positive = we got a worse price than the whale did
    const slippagePct = p.whalePrice > 0
      ? (p.signal.side === 'buy' ? outcome.price / p.whalePrice - 1 : p.whalePrice / outcome.price - 1) * 100
      : undefined;
    recordSignal({ ...base, action: 'copied', detail: 'ok', slippagePct });

    const held = getWhalePositions(whale.address).find((wp) => wp.mint === p.signal.mint)
      ?? { whale: whale.address, mint: p.signal.mint, amountRaw: 0n, costUsd: 0 };
    transaction(() => {
      if (p.signal.side === 'buy') {
        saveWhalePosition({ ...held, amountRaw: held.amountRaw + outcome.tokenRaw, costUsd: held.costUsd + outcome.usd });
      } else {
        const left = held.amountRaw - outcome.tokenRaw;
        const keptCost = held.amountRaw > 0n ? held.costUsd * (Number(left) / Number(held.amountRaw)) : 0;
        saveWhalePosition({ ...held, amountRaw: left > 0n ? left : 0n, costUsd: left > 0n ? keptCost : 0 });
      }
    });
    const vsWhale = slippagePct !== undefined ? `\nvs ${whale.label}: ${slippagePct >= 0 ? `${slippagePct.toFixed(2)}% worse` : `${(-slippagePct).toFixed(2)}% better`} price, ${Math.round(p.delaySec)}s later` : '';
    messages.push(`🐋 ${formatOutcome(outcome)}${vsWhale}`);
  });
  return messages;
}

/** A whale can hold a coin down to zero. We don't have to. */
async function enforceCopyStopLoss(): Promise<string[]> {
  const settings = getCopySettings();
  const positions = getWhalePositions();
  if (positions.length === 0) return [];
  const prices = await fetchPrices(positions.map((p) => p.mint));
  const orders: { order: Order; held: WhalePosition }[] = [];
  for (const held of positions) {
    const token = tokenByMint(held.mint);
    const price = prices.get(held.mint);
    if (!token || price === undefined || held.costUsd <= 0) continue;
    const change = (toUi(held.amountRaw, token.decimals) * price / held.costUsd - 1) * 100;
    if (change <= -settings.stopLossPct) {
      const label = listWhales().find((w) => w.address === held.whale)?.label ?? short(held.whale);
      orders.push({
        held,
        order: { side: 'sell', token, amount: 1, sellRaw: held.amountRaw, strategyId: null, whale: held.whale, reason: `Copy stop-loss: ${token.symbol} from ${label} is down ${(-change).toFixed(1)}% (limit −${settings.stopLossPct}%)` },
      });
    }
  }
  if (orders.length === 0) return [];
  const outcomes = await placeOrders(orders.map((o) => o.order));
  return outcomes.map((outcome, i) => {
    if (outcome.ok) saveWhalePosition({ ...orders[i].held, amountRaw: 0n, costUsd: 0 });
    return `🐋 ${formatOutcome(outcome)}`;
  });
}

export type WhaleStats = {
  copiedBuys: number; copiedSells: number; wins: number; spentUsd: number; realizedUsd: number; feesUsd: number;
  unrealizedUsd: number; netUsd: number; avgDelaySec: number | null; avgSlippagePct: number | null; skipped: number;
};

export async function whaleStats(address: string, prices?: Map<string, number>): Promise<WhaleStats> {
  const t = db.prepare(
    `SELECT SUM(side = 'buy') AS buys, SUM(side = 'sell') AS sells, SUM(side = 'sell' AND realized_pnl > 0) AS wins,
            SUM(CASE WHEN side = 'buy' THEN usd ELSE 0 END) AS spent, SUM(realized_pnl) AS realized, SUM(fee_usd) AS fees
     FROM trades WHERE whale = ? AND mode = 'paper'`,
  ).get(address) as Record<string, number | null>;
  const s = db.prepare(
    `SELECT AVG(delay_sec) AS delay, AVG(slippage_pct) AS slip, SUM(action = 'skipped') AS skipped
     FROM whale_signals WHERE whale = ? AND (action = 'copied' OR action = 'skipped')`,
  ).get(address) as Record<string, number | null>;

  const held = getWhalePositions(address);
  const p = prices ?? (held.length ? await fetchPrices(held.map((h) => h.mint)) : new Map());
  const unrealizedUsd = held.reduce((sum, h) => {
    const token = tokenByMint(h.mint);
    const price = p.get(h.mint);
    return token && price !== undefined ? sum + toUi(h.amountRaw, token.decimals) * price - h.costUsd : sum;
  }, 0);
  const realizedUsd = t.realized ?? 0;
  const feesUsd = t.fees ?? 0;
  return {
    copiedBuys: t.buys ?? 0, copiedSells: t.sells ?? 0, wins: t.wins ?? 0, spentUsd: t.spent ?? 0,
    realizedUsd, feesUsd, unrealizedUsd, netUsd: realizedUsd + unrealizedUsd - feesUsd,
    avgDelaySec: s.delay, avgSlippagePct: s.slip, skipped: s.skipped ?? 0,
  };
}

/** Judged on evidence: after enough closed copies, a whale that loses money gets paused. */
function autoPauseLosingWhales(): string[] {
  const settings = getCopySettings();
  const messages: string[] = [];
  for (const whale of listWhales().filter((w) => w.enabled)) {
    const t = db.prepare(
      `SELECT SUM(side = 'sell') AS sells, SUM(CASE WHEN side = 'buy' THEN usd ELSE 0 END) AS spent,
              SUM(realized_pnl) AS realized, SUM(fee_usd) AS fees
       FROM trades WHERE whale = ? AND mode = 'paper'`,
    ).get(whale.address) as Record<string, number | null>;
    const sells = t.sells ?? 0;
    const spent = t.spent ?? 0;
    const net = (t.realized ?? 0) - (t.fees ?? 0);
    if (sells < settings.autoPauseAfterSells || spent <= 0) continue;
    const pct = (net / spent) * 100;
    if (pct < -settings.autoPauseLossPct) {
      const reason = `lost ${(-pct).toFixed(1)}% of ${usd(spent)} copied over ${sells} closed trades`;
      setWhaleEnabled(whale.address, false, reason);
      messages.push(`🐋⏸ Auto-paused ${whale.label}: ${reason}. Their open copied positions are kept (stop-loss still applies). /whales to review.`);
    }
  }
  return messages;
}

export function formatWhaleStats(whale: Whale, s: WhaleStats): string {
  const status = whale.enabled ? '🟢' : `⏸${whale.pausedReason ? ` (${whale.pausedReason})` : ''}`;
  const winRate = s.copiedSells ? ` · win ${Math.round((s.wins / s.copiedSells) * 100)}%` : '';
  const exec = s.avgSlippagePct !== null
    ? `\n   avg ${Math.round(s.avgDelaySec ?? 0)}s behind them, ${Math.abs(s.avgSlippagePct).toFixed(2)}% ${s.avgSlippagePct >= 0 ? 'worse' : 'better'} price`
    : '';
  return `${status} ${whale.label} ${short(whale.address)}\n   ${s.copiedBuys} buys, ${s.copiedSells} sells${winRate} · net ${s.netUsd >= 0 ? '+' : '−'}${usd(Math.abs(s.netUsd))} (fees incl.) · ${s.skipped} skipped${exec}`;
}

