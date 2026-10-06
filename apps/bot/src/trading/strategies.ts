// Pure strategy logic: no I/O, so it's easy to test and later to backtest.
import { toUi, tokenByMint } from '../tokens.ts';
import type { DcaParams, Order, Position, StrategyRow, TpslParams } from './types.ts';

const HOUR = 3_600_000;

export function describeStrategy(s: StrategyRow): string {
  const symbol = tokenByMint(s.params.mint)?.symbol ?? '?';
  if (s.type === 'dca') return `DCA: buy $${s.params.usd} of ${symbol} every ${s.params.everyHours}h`;
  const parts = [];
  if (s.params.takeProfitPct) parts.push(`take profit at +${s.params.takeProfitPct}%`);
  if (s.params.stopLossPct) parts.push(`stop loss at −${s.params.stopLossPct}%`);
  return `TP/SL on ${symbol}: ${parts.join(', ')}`;
}

/**
 * Is a DCA buy due? If the bot was offline through several scheduled buys,
 * it buys ONCE (not N times) and reports how many it skipped.
 */
export function dcaDue(lastRunAt: number | undefined, everyHours: number, now: number): { due: boolean; missed: number } {
  if (lastRunAt === undefined) return { due: true, missed: 0 };
  const elapsed = now - lastRunAt;
  const every = everyHours * HOUR;
  if (elapsed < every) return { due: false, missed: 0 };
  return { due: true, missed: Math.max(0, Math.floor(elapsed / every) - 1) };
}

export function runDca(id: number, p: DcaParams, lastRunAt: number | undefined, now: number): Order | null {
  const { due, missed } = dcaDue(lastRunAt, p.everyHours, now);
  const token = tokenByMint(p.mint);
  if (!due || !token) return null;
  const catchUp = missed > 0 ? ` (catching up: ${missed} scheduled buy(s) missed while offline, buying once)` : '';
  return { side: 'buy', token, amount: p.usd, strategyId: id, reason: `Scheduled DCA buy every ${p.everyHours}h${catchUp}` };
}

/** % change of the current price vs the position's average entry price. */
export function changeVsEntry(position: Position, decimals: number, price: number): number | null {
  const amount = toUi(position.amountRaw, decimals);
  if (amount <= 0 || position.costUsd <= 0) return null;
  return (price / (position.costUsd / amount) - 1) * 100;
}

export function runTpsl(id: number, p: TpslParams, position: Position | undefined, price: number | undefined): Order | null {
  const token = tokenByMint(p.mint);
  if (!token || !position || price === undefined) return null;
  // Ignore dust (under 1 cent)
  if (toUi(position.amountRaw, token.decimals) * price < 0.01) return null;
  const change = changeVsEntry(position, token.decimals, price);
  if (change === null) return null;

  const fmt = `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
  const EPSILON = 1e-9; // floating point: exactly +15% can compute as +14.9999999%
  if (p.takeProfitPct > 0 && change >= p.takeProfitPct - EPSILON) {
    return { side: 'sell', token, amount: 1, strategyId: id, reason: `Take-profit: ${token.symbol} is ${fmt} vs your average entry (target +${p.takeProfitPct}%)` };
  }
  if (p.stopLossPct > 0 && change <= -p.stopLossPct + EPSILON) {
    return { side: 'sell', token, amount: 1, strategyId: id, reason: `Stop-loss: ${token.symbol} is ${fmt} vs your average entry (limit −${p.stopLossPct}%)` };
  }
  return null;
}
