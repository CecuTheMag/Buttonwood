import type { Token } from '../tokens.ts';
import type { Sleeve } from './sleeve.ts';

export type Limits = {
  maxTradeUsd: number;        // largest single buy
  maxPositionPct: number;     // max % of portfolio in one token (checked on buys)
  maxDailyLossPct: number;    // portfolio drop since 00:00 UTC that pauses buying
  maxTradesPerHour: number;
  maxPriceDeviationPct: number; // quote vs reference price: catches broken routes and thin pools
  slippageBps: number;
};

export const DEFAULT_LIMITS: Limits = {
  maxTradeUsd: 50,
  maxPositionPct: 30,
  maxDailyLossPct: 5,
  maxTradesPerHour: 10,
  maxPriceDeviationPct: 1,
  slippageBps: 50,
};

/** A trade a strategy (or you) wants to make. Always against USDC. */
export type Order = {
  side: 'buy' | 'sell';
  token: Token;
  /** buy: USD (USDC) to spend · sell: fraction of the position to sell (0–1] */
  amount: number;
  /** sell an exact amount instead of a fraction (clamped to what you hold) */
  sellRaw?: bigint;
  reason: string;
  strategyId: number | null;
  /** the whale this copies, for per-whale performance */
  whale?: string;
  /** passed the token safety check, so it may be bought even though it's not on the allowlist */
  vetted?: boolean;
  /** a sleeve strategy's budget: its orders may be as large as its budget (it IS the size limit) */
  budgetUsd?: number;
};

export type Position = { mint: string; amountRaw: bigint; costUsd: number };

export type DcaParams = { mint: string; usd: number; everyHours: number };
export type TpslParams = { mint: string; takeProfitPct: number; stopLossPct: number };

/** Trend / grid / rebalance: a strategy with its own budget ("sleeve"). */
export type SleeveState = {
  sleeve: Sleeve;
  invested: number;     // total capital ever assigned (for return on capital)
  peakValue: number;    // for drawdown
  startedAt: number;
  pausedReason?: string;
};

export type StrategyRow =
  | { id: number; type: 'dca'; params: DcaParams; enabled: boolean; state: { lastRunAt?: number } }
  | { id: number; type: 'tpsl'; params: TpslParams; enabled: boolean; state: Record<string, never> }
  | { id: number; type: 'trend' | 'grid' | 'rebalance'; params: { mint: string } & Record<string, number | string>; enabled: boolean; state: SleeveState };
