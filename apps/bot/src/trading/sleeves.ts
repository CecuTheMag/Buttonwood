// Live runtime for sleeve strategies (trend / grid / rebalance): same decide() as the backtester.
import { toRaw, toUi, tokenByMint } from '../tokens.ts';
import { getBars } from './candles.ts';
import type { Outcome, Prices } from './engine.ts';
import { applySleeveFill, newSleeve, sleeveValue } from './sleeve.ts';
import { addStrategy, saveStrategyState } from './store.ts';
import { SLEEVE_STRATEGIES } from './strategyLib.ts';
import type { Order, SleeveState, StrategyRow } from './types.ts';

export type SleeveRow = Extract<StrategyRow, { type: 'trend' | 'grid' | 'rebalance' }>;
export const isSleeveRow = (s: StrategyRow): s is SleeveRow => s.type === 'trend' || s.type === 'grid' || s.type === 'rebalance';

export function addSleeveStrategy(type: SleeveRow['type'], mint: string, budgetUsd: number, params: Record<string, number> = {}): number {
  const state: SleeveState = { sleeve: newSleeve(budgetUsd), invested: budgetUsd, peakValue: budgetUsd, startedAt: Date.now() };
  const id = addStrategy(type, { mint, ...params } as any);
  saveStrategyState(id, state);
  return id;
}

export const sleeveParams = (s: SleeveRow) => {
  const def = SLEEVE_STRATEGIES[s.type];
  const { mint: _mint, ...rest } = s.params;
  return { ...def.defaults, ...rest };
};

export function sleeveStats(s: SleeveRow, price: number | undefined) {
  const value = price !== undefined ? sleeveValue(s.state.sleeve, price) : s.state.sleeve.cashUsd;
  const peak = Math.max(s.state.peakValue, value);
  return {
    value,
    returnPct: s.state.invested > 0 ? (value / s.state.invested - 1) * 100 : 0,
    drawdownPct: peak > 0 ? ((peak - value) / peak) * 100 : 0,
    days: (Date.now() - s.state.startedAt) / 86_400_000,
  };
}

/** One tick for one sleeve strategy. `place` is the engine's order function (already inside its lock). */
export async function runSleeve(s: SleeveRow, prices: Prices, place: (o: Order) => Promise<Outcome>): Promise<Outcome | null> {
  const def = SLEEVE_STRATEGIES[s.type];
  const token = tokenByMint(s.params.mint);
  const price = prices.get(s.params.mint);
  if (!token || price === undefined) return null;
  const params = sleeveParams(s);
  const bars = getBars(s.params.mint, def.warmupBars(params) + 2);
  if (bars.length < def.warmupBars(params)) return null; // waiting for price history

  const state: SleeveState = { ...s.state, sleeve: { ...s.state.sleeve } };
  const { decision, memo } = def.decide(params, bars, price, state.sleeve);
  state.sleeve.memo = memo;

  let outcome: Outcome | null = null;
  if (decision) {
    const order: Order = decision.side === 'buy'
      ? { side: 'buy', token, amount: decision.usd, strategyId: s.id, reason: decision.reason, budgetUsd: state.sleeve.budgetUsd }
      : { side: 'sell', token, amount: 1, sellRaw: toRaw(state.sleeve.tokens * Math.min(1, decision.fraction), token.decimals), strategyId: s.id, reason: decision.reason };
    outcome = await place(order);
    if (outcome.ok) {
      state.sleeve = applySleeveFill(state.sleeve, decision.side, toUi(outcome.tokenRaw, token.decimals), outcome.usd, outcome.feeUsd).sleeve;
    } else if (decision.side === 'sell' && outcome.reason.startsWith("you don't hold")) {
      state.sleeve = { ...state.sleeve, tokens: 0, costUsd: 0 }; // position was sold elsewhere (e.g. manual /sell)
    }
  }
  state.peakValue = Math.max(state.peakValue, sleeveValue(state.sleeve, price));
  saveStrategyState(s.id, state);
  return outcome;
}
