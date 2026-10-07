// Pure. A "sleeve" is a strategy's own pot of money inside the paper account: its cash, its tokens,
// its memory. Shared by live trading and the backtester so both run exactly the same logic.

export type Bar = { ts: number; close: number }; // ts in seconds; hourly closes, oldest first

export type Sleeve = {
  budgetUsd: number;     // capital assigned by you or the tournament
  cashUsd: number;
  tokens: number;        // token amount (human units)
  costUsd: number;       // cost basis of `tokens`
  memo: Record<string, any>; // strategy memory (grid levels, last decided bar…)
};

export type Decision =
  | { side: 'buy'; usd: number; reason: string }
  | { side: 'sell'; fraction: number; reason: string };

export type DecideResult = { decision: Decision | null; memo: Record<string, any> };

export interface SleeveStrategy<P> {
  type: string;
  label: string;
  defaults: P;
  describe(p: P): string;
  /** Hourly bars needed before the strategy can decide. */
  warmupBars(p: P): number;
  /** `bars` = completed hourly closes; `price` = the price right now. */
  decide(p: P, bars: Bar[], price: number, sleeve: Sleeve): DecideResult;
}

export const newSleeve = (budgetUsd: number): Sleeve => ({ budgetUsd, cashUsd: budgetUsd, tokens: 0, costUsd: 0, memo: {} });
export const sleeveValue = (s: Sleeve, price: number) => s.cashUsd + s.tokens * price;

/** Apply a fill. Buys: spent `usd` for `tokens`. Sells: sold `tokens` for `usd`. Fees come out of cash. */
export function applySleeveFill(s: Sleeve, side: 'buy' | 'sell', tokens: number, usd: number, feeUsd: number): { sleeve: Sleeve; realizedUsd: number } {
  if (side === 'buy') {
    return { sleeve: { ...s, cashUsd: s.cashUsd - usd - feeUsd, tokens: s.tokens + tokens, costUsd: s.costUsd + usd }, realizedUsd: 0 };
  }
  const sold = Math.min(tokens, s.tokens);
  const cost = s.tokens > 0 ? s.costUsd * (sold / s.tokens) : 0;
  const left = s.tokens - sold;
  return {
    sleeve: { ...s, cashUsd: s.cashUsd + usd - feeUsd, tokens: left < 1e-12 ? 0 : left, costUsd: left < 1e-12 ? 0 : s.costUsd - cost },
    realizedUsd: usd - cost - feeUsd,
  };
}

export const sma = (values: number[], n: number) => (values.length < n ? NaN : values.slice(-n).reduce((a, b) => a + b, 0) / n);
