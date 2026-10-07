// Pure backtester: replays a sleeve strategy over hourly bars with pessimistic costs.
import { applySleeveFill, newSleeve, sleeveValue, type Bar, type SleeveStrategy } from './sleeve.ts';

export type BacktestOptions = {
  budgetUsd: number;
  costPct: number;  // slippage + DEX fees per trade, % of trade value (pessimistic default)
  feeUsd: number;   // network fee per trade
};

export const DEFAULT_BACKTEST: BacktestOptions = { budgetUsd: 100, costPct: 0.3, feeUsd: 0.02 };

export type BacktestResult = {
  bars: number;
  days: number;
  trades: number;
  closedTrades: number;
  wins: number;
  returnPct: number;        // strategy
  holdReturnPct: number;    // just buying the token at the start
  maxDrawdownPct: number;
  exposurePct: number;      // share of time holding the token
  avgDailyPct: number;
  equity: number[];         // per bar
};

export function maxDrawdown(values: number[]): number {
  let peak = -Infinity, worst = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) worst = Math.max(worst, ((peak - v) / peak) * 100);
  }
  return worst;
}

export function backtest<P>(strategy: SleeveStrategy<P>, params: P, bars: Bar[], opts: BacktestOptions = DEFAULT_BACKTEST): BacktestResult {
  let sleeve = newSleeve(opts.budgetUsd);
  const warmup = strategy.warmupBars(params);
  const equity: number[] = [];
  let trades = 0, closed = 0, wins = 0, exposed = 0;

  for (let i = warmup; i < bars.length; i++) {
    const price = bars[i].close;
    // Decide on completed bars up to i-1 plus the current price (bar i), like live trading
    const { decision, memo } = strategy.decide(params, bars.slice(0, i), price, sleeve);
    sleeve = { ...sleeve, memo };
    if (decision) {
      if (decision.side === 'buy') {
        const usd = Math.min(decision.usd, sleeve.cashUsd - opts.feeUsd);
        if (usd > 0) {
          const fillPrice = price * (1 + opts.costPct / 100);
          sleeve = applySleeveFill(sleeve, 'buy', usd / fillPrice, usd, opts.feeUsd).sleeve;
          trades++;
        }
      } else if (sleeve.tokens > 0) {
        const tokens = sleeve.tokens * Math.min(1, decision.fraction);
        const fillPrice = price * (1 - opts.costPct / 100);
        const fill = applySleeveFill(sleeve, 'sell', tokens, tokens * fillPrice, opts.feeUsd);
        sleeve = fill.sleeve;
        trades++;
        closed++;
        if (fill.realizedUsd > 0) wins++;
      }
    }
    if (sleeve.tokens > 0) exposed++;
    equity.push(sleeveValue(sleeve, price));
  }

  const n = equity.length;
  const first = bars[warmup]?.close ?? bars[0]?.close ?? 1;
  const last = bars.at(-1)?.close ?? first;
  const days = n / 24;
  const end = equity.at(-1) ?? opts.budgetUsd;
  return {
    bars: n,
    days,
    trades,
    closedTrades: closed,
    wins,
    returnPct: (end / opts.budgetUsd - 1) * 100,
    holdReturnPct: (last / first - 1) * 100,
    maxDrawdownPct: maxDrawdown(equity),
    exposurePct: n ? (exposed / n) * 100 : 0,
    avgDailyPct: days >= 1 && end > 0 ? ((end / opts.budgetUsd) ** (1 / days) - 1) * 100 : 0,
    equity,
  };
}

/** One number to rank by: return, punished for drawdown, nothing for doing nothing. */
export const backtestScore = (r: BacktestResult) => (r.trades === 0 ? -Infinity : r.returnPct - 0.5 * r.maxDrawdownPct);
