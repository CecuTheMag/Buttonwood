// Pure risk checks. Strategies propose; this decides. No I/O.
import type { Limits } from './types.ts';

export type RiskInput = {
  side: 'buy' | 'sell';
  orderUsd: number;
  allowed: boolean;            // token is on the allowlist
  positionUsdAfter: number;    // value of this token's position if the order fills
};

export type RiskState = {
  killSwitch: boolean;
  tradesLastHour: number;
  portfolioUsd: number;
  dayStartUsd: number | undefined;
};

export type Verdict = { ok: true } | { ok: false; reason: string };

export function checkOrder(order: RiskInput, state: RiskState, limits: Limits): Verdict {
  if (state.killSwitch) return { ok: false, reason: 'trading is stopped (/resume to restart)' };
  if (!order.allowed) return { ok: false, reason: 'token is not on the allowlist' };
  if (order.orderUsd <= 0) return { ok: false, reason: 'nothing to trade' };

  // Sells reduce risk, so the rate, size, concentration and daily-loss limits only apply to buys.
  // That way a stop-loss can always get you out.
  if (order.side === 'buy') {
    if (state.tradesLastHour >= limits.maxTradesPerHour) {
      return { ok: false, reason: `rate limit: already ${state.tradesLastHour} trades in the last hour` };
    }
    if (order.orderUsd > limits.maxTradeUsd) {
      return { ok: false, reason: `$${order.orderUsd.toFixed(2)} is above the $${limits.maxTradeUsd} max trade size` };
    }
    if (state.dayStartUsd && state.dayStartUsd > 0) {
      const lossPct = ((state.dayStartUsd - state.portfolioUsd) / state.dayStartUsd) * 100;
      if (lossPct >= limits.maxDailyLossPct) {
        return { ok: false, reason: `daily loss limit: down ${lossPct.toFixed(1)}% today (limit ${limits.maxDailyLossPct}%). Buying pauses until 00:00 UTC; sells still work` };
      }
    }
    if (state.portfolioUsd > 0) {
      const pct = (order.positionUsdAfter / state.portfolioUsd) * 100;
      if (pct > limits.maxPositionPct) {
        return { ok: false, reason: `would put ${pct.toFixed(0)}% of the portfolio in one token (limit ${limits.maxPositionPct}%)` };
      }
    }
  }
  return { ok: true };
}

/** Quote vs reference price. A big gap means a thin pool, a broken route, or a bad price feed. */
export function checkPriceDeviation(fillPrice: number, referencePrice: number, limits: Limits): Verdict {
  const deviation = Math.abs(fillPrice / referencePrice - 1) * 100;
  if (deviation > limits.maxPriceDeviationPct) {
    return { ok: false, reason: `quote price is ${deviation.toFixed(2)}% away from the market price (limit ${limits.maxPriceDeviationPct}%)` };
  }
  return { ok: true };
}
