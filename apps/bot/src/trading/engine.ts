import { formatAmount, usd } from '../format.ts';
import { getUsdPrices } from '../prices.ts';
import { SOL_MINT, TOKENS, USDC_MINT, isAllowlisted, toUi, tokenByMint } from '../tokens.ts';
import { applyFill } from './accounting.ts';
import { getQuote, routeLabel } from './jupiter.ts';
import { checkOrder, checkPriceDeviation } from './risk.ts';
import * as store from './store.ts';
import { changeVsEntry, runDca, runTpsl } from './strategies.ts';
import { recordPrice } from './candles.ts';
import { isSleeveRow, runSleeve } from './sleeves.ts';
import { accrueYield } from './yield.ts';
import type { Order, Position } from './types.ts';

const HOUR = 3_600_000;

/** mint → USD. USDC is pinned to $1 for paper cash accounting. */
export type Prices = Map<string, number>;

export type Outcome =
  | { ok: true; order: Order; tokenRaw: bigint; usd: number; price: number; realizedPnlUsd: number; feeUsd: number; cashUsd: number; route: string }
  | { ok: false; order: Order; reason: string };

/** Prices for the allowlist, everything held, and any extra mints. */
export async function fetchPrices(extraMints: string[] = []): Promise<Prices> {
  const mints = new Set([...TOKENS.map((t) => t.mint), ...store.getPositions().keys(), ...extraMints]);
  const raw = await getUsdPrices([...mints]);
  const prices: Prices = new Map(Object.entries(raw).map(([key, price]) => [key === 'SOL' ? SOL_MINT : key, price]));
  prices.set(USDC_MINT, 1);
  return prices;
}

// Strategy ticks and manual commands both change balances: run them one at a time.
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

const zero = (mint: string): Position => ({ mint, amountRaw: 0n, costUsd: 0 });

export function valuePortfolio(positions: Map<string, Position>, prices: Prices) {
  const cashUsd = toUi(positions.get(USDC_MINT)?.amountRaw ?? 0n, 6);
  const holdings = [...positions.values()].flatMap((position) => {
    const token = tokenByMint(position.mint);
    if (!token || position.mint === USDC_MINT || position.amountRaw === 0n) return [];
    const price = prices.get(token.mint);
    const amount = toUi(position.amountRaw, token.decimals);
    return [{ token, position, amount, valueUsd: price !== undefined ? amount * price : 0, changePct: price !== undefined ? changeVsEntry(position, token.decimals, price) : null }];
  });
  const totalUsd = cashUsd + holdings.reduce((sum, h) => sum + h.valueUsd, 0);
  return { cashUsd, holdings, totalUsd };
}

/** Portfolio value at the first check of the UTC day: the baseline for the daily loss limit. */
function dayStartUsd(totalUsd: number): number {
  const today = new Date().toISOString().slice(0, 10);
  const saved = store.getSetting<{ date: string; usd: number } | null>('day_start', null);
  if (saved?.date === today) return saved.usd;
  store.setSetting('day_start', { date: today, usd: totalUsd });
  return totalUsd;
}

async function placeOrderNow(order: Order, prices: Prices): Promise<Outcome> {
  const reject = (reason: string): Outcome => ({ ok: false, order, reason });
  const { token } = order;
  const limits = store.getLimits();
  const positions = store.getPositions();
  const cash = positions.get(USDC_MINT) ?? zero(USDC_MINT);
  const position = positions.get(token.mint) ?? zero(token.mint);

  const refPrice = prices.get(token.mint);
  if (!refPrice) return reject('no market price available right now');

  let orderUsd: number;
  let sellRaw = 0n;
  if (order.side === 'buy') {
    orderUsd = order.amount;
  } else {
    sellRaw = order.sellRaw !== undefined
      ? (order.sellRaw < position.amountRaw ? order.sellRaw : position.amountRaw)
      : order.amount >= 1 ? position.amountRaw : BigInt(Math.floor(Number(position.amountRaw) * order.amount));
    if (sellRaw <= 0n) return reject(`you don't hold any paper ${token.symbol}`);
    orderUsd = toUi(sellRaw, token.decimals) * refPrice;
  }

  const { totalUsd } = valuePortfolio(positions, prices);
  const currentUsd = toUi(position.amountRaw, token.decimals) * refPrice;
  const verdict = checkOrder(
    {
      side: order.side,
      orderUsd,
      // Buying needs the allowlist or a passed safety check. Selling is always allowed: never get stuck in a position.
      allowed: order.side === 'sell' || isAllowlisted(token.mint) || order.vetted === true,
      positionUsdAfter: currentUsd + (order.side === 'buy' ? orderUsd : -orderUsd),
      maxTradeUsd: order.budgetUsd,
    },
    { killSwitch: store.isStopped(), tradesLastHour: store.tradesSince(Date.now() - HOUR), portfolioUsd: totalUsd, dayStartUsd: dayStartUsd(totalUsd) },
    limits,
  );
  if (!verdict.ok) return reject(verdict.reason);
  if (order.side === 'buy' && toUi(cash.amountRaw, 6) < orderUsd + store.PAPER_FEE_USD) {
    return reject(`not enough paper cash (${usd(toUi(cash.amountRaw, 6))} left)`);
  }

  // A real quote from Jupiter: the price you would actually have gotten right now.
  let quote;
  try {
    quote = order.side === 'buy'
      ? await getQuote(USDC_MINT, token.mint, BigInt(Math.round(orderUsd * 1e6)), limits.slippageBps)
      : await getQuote(token.mint, USDC_MINT, sellRaw, limits.slippageBps);
  } catch (err) {
    return reject((err as Error).message);
  }
  const tokenRaw = order.side === 'buy' ? BigInt(quote.outAmount) : sellRaw;
  const fillUsd = order.side === 'buy' ? toUi(BigInt(quote.inAmount), 6) : toUi(BigInt(quote.outAmount), 6);
  if (tokenRaw <= 0n || fillUsd <= 0) return reject('the quote came back empty');
  const price = fillUsd / toUi(tokenRaw, token.decimals);

  const deviation = checkPriceDeviation(price, refPrice, limits);
  if (!deviation.ok) return reject(deviation.reason);

  const { position: next, realizedPnlUsd } = applyFill(position, { side: order.side, tokenRaw, usd: fillUsd });
  const feeRaw = BigInt(Math.round(store.PAPER_FEE_USD * 1e6));
  const cashRaw = (order.side === 'buy' ? cash.amountRaw - BigInt(quote.inAmount) : cash.amountRaw + BigInt(quote.outAmount)) - feeRaw;

  store.transaction(() => {
    store.savePosition(next);
    store.savePosition({ ...cash, amountRaw: cashRaw });
    store.recordTrade({
      mode: 'paper', strategyId: order.strategyId, side: order.side, mint: token.mint, tokenRaw, usd: fillUsd,
      price, refPrice, realizedPnl: realizedPnlUsd, reason: order.reason, signature: null, createdAt: Date.now(),
      whale: order.whale ?? null, feeUsd: store.PAPER_FEE_USD,
    });
  });

  return { ok: true, order, tokenRaw, usd: fillUsd, price, realizedPnlUsd, feeUsd: store.PAPER_FEE_USD, cashUsd: toUi(cashRaw, 6), route: routeLabel(quote) };
}

/** Manual trades (/buy, /sell) go through exactly the same checks as strategies. */
export function placeOrder(order: Order): Promise<Outcome> {
  return exclusive(async () => placeOrderNow(order, await fetchPrices([order.token.mint])));
}

/** Several orders in one exclusive block (used by whale copying). */
export function placeOrders(orders: Order[]): Promise<Outcome[]> {
  return exclusive(async () => {
    const prices = await fetchPrices(orders.map((o) => o.token.mint));
    const outcomes: Outcome[] = [];
    for (const order of orders) outcomes.push(await placeOrderNow(order, prices));
    return outcomes;
  });
}

// TP/SL re-evaluates every minute; only report a blocked order again if the reason changes.
const lastRejection = new Map<number, string>();

/** One engine tick: run every enabled strategy. Returns messages for the owner. */
export function runStrategies(): Promise<string[]> {
  return exclusive(async () => {
    const prices = await fetchPrices();
    if (prices.size <= 1) {
      console.warn('Engine: no prices this tick, skipping');
      return [];
    }
    for (const [mint, price] of prices) if (mint !== USDC_MINT) recordPrice(mint, price); // builds hourly history
    accrueYield(prices);
    const { totalUsd } = valuePortfolio(store.getPositions(), prices);
    dayStartUsd(totalUsd);
    store.snapshotEquity(totalUsd);
    if (store.getSetting<number | null>('paper_start_sol_price', null) === null && prices.get(SOL_MINT)) {
      store.setSetting('paper_start_sol_price', prices.get(SOL_MINT)); // benchmark: "just hold SOL"
    }
    if (store.isStopped()) return [];

    const messages: string[] = [];
    const now = Date.now();
    for (const strategy of store.listStrategies().filter((s) => s.enabled)) {
      if (isSleeveRow(strategy)) {
        const outcome = await runSleeve(strategy, prices, (o) => placeOrderNow(o, prices));
        if (outcome?.ok) {
          lastRejection.delete(strategy.id);
          messages.push(formatOutcome(outcome));
        } else if (outcome && lastRejection.get(strategy.id) !== outcome.reason) {
          lastRejection.set(strategy.id, outcome.reason);
          messages.push(formatOutcome(outcome));
        }
        continue;
      }
      let order: Order | null;
      if (strategy.type === 'dca') {
        order = runDca(strategy.id, strategy.params, strategy.state.lastRunAt, now);
        // Mark the run before trading: a crash or a rejection must not cause a retry every minute.
        if (order) store.saveStrategyState(strategy.id, { lastRunAt: now });
      } else {
        order = runTpsl(strategy.id, strategy.params, store.getPositions().get(strategy.params.mint), prices.get(strategy.params.mint));
      }
      if (!order) continue;

      const outcome = await placeOrderNow(order, prices);
      if (outcome.ok) {
        lastRejection.delete(strategy.id);
        messages.push(formatOutcome(outcome));
      } else if (strategy.type === 'dca' || lastRejection.get(strategy.id) !== outcome.reason) {
        lastRejection.set(strategy.id, outcome.reason);
        messages.push(formatOutcome(outcome));
      }
    }
    return messages;
  });
}

const price = (n: number) => `$${formatAmount(n)}`;
const signedUsd = (n: number) => (Math.abs(n) < 0.005 ? '$0.00' : `${n > 0 ? '+' : '−'}${usd(Math.abs(n))}`);
const signedPct = (n: number, digits = 2) => (Math.abs(n) < 0.5 * 10 ** -digits ? `0.${'0'.repeat(digits)}%` : `${n > 0 ? '+' : '−'}${Math.abs(n).toFixed(digits)}%`);

export function formatOutcome(o: Outcome): string {
  const { token } = o.order;
  if (!o.ok) {
    const what = o.order.side === 'buy' ? `buy of ${usd(o.order.amount)} ${token.symbol}` : `sell of ${token.symbol}`;
    return `📄 PAPER · ⛔ Skipped ${what}\nWhy: ${o.order.reason}\nBlocked: ${o.reason}`;
  }
  const amount = `${formatAmount(toUi(o.tokenRaw, token.decimals))} ${token.symbol}`;
  const head = o.order.side === 'buy'
    ? `📄 PAPER · 🟢 Bought ${amount} for ${usd(o.usd)} @ ${price(o.price)}`
    : `📄 PAPER · 🔴 Sold ${amount} for ${usd(o.usd)} @ ${price(o.price)} · PnL ${signedUsd(o.realizedPnlUsd)}`;
  return `${head}\nWhy: ${o.order.reason}\nRoute: ${o.route} · fee ${usd(o.feeUsd)}\nPaper cash: ${usd(o.cashUsd)}`;
}

export async function formatPaperPortfolio(): Promise<string> {
  const prices = await fetchPrices();
  const { cashUsd, holdings, totalUsd } = valuePortfolio(store.getPositions(), prices);
  const startUsd = store.getSetting('paper_start_usd', store.DEFAULT_PAPER_USD);
  const pnl = totalUsd - startUsd;
  const realized = store.realizedPnlTotal();
  const unrealized = holdings.reduce((sum, h) => sum + (h.valueUsd - h.position.costUsd), 0);

  const lines = [
    '📄 Paper portfolio (fake money, real prices)',
    `Value: ${usd(totalUsd)} (${signedUsd(pnl)}, ${signedPct((pnl / startUsd) * 100)} since start at ${usd(startUsd)})`,
    `Realized: ${signedUsd(realized)} · Unrealized: ${signedUsd(unrealized)}`,
    '',
    `💵 Cash: ${usd(cashUsd)} USDC`,
    ...holdings.map((h) =>
      `• ${formatAmount(h.amount)} ${h.token.symbol}  ${usd(h.valueUsd)}${h.changePct !== null ? `  (${signedPct(h.changePct, 1)} vs entry)` : ''}`),
    '',
    store.isStopped() ? '⏸ Trading is STOPPED (/resume)' : '▶️ Trading is running',
  ];
  return lines.join('\n');
}

