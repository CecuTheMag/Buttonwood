import { getSetting, setSetting } from './store.ts';

export type CopySettings = {
  usdPerTrade: number;        // default size of each copied buy
  minWhaleTradeUsd: number;   // ignore whale trades smaller than this (noise, tests, dust)
  maxCopyDelaySec: number;    // don't copy BUYS seen later than this (sells are always copied)
  minLiquidityUsd: number;    // token safety
  minHolders: number;
  maxTopHoldersPct: number;
  minAgeHours: number;
  maxRoundTripLossPct: number; // buy-then-sell quote must lose less than this: catches honeypots and thin pools
  stopLossPct: number;        // exit a copied position if it falls this far, even if the whale holds
  autoPauseAfterSells: number; // judge a whale after this many copied sells…
  autoPauseLossPct: number;   // …and pause it if it lost more than this % of what was spent copying it
};

export const DEFAULT_COPY: CopySettings = {
  usdPerTrade: 20,
  minWhaleTradeUsd: 200,
  maxCopyDelaySec: 120,
  minLiquidityUsd: 250_000,
  minHolders: 500,
  maxTopHoldersPct: 60,
  minAgeHours: 24,
  maxRoundTripLossPct: 3,
  stopLossPct: 25,
  autoPauseAfterSells: 5,
  autoPauseLossPct: 5,
};

export const getCopySettings = (): CopySettings => ({ ...DEFAULT_COPY, ...getSetting<Partial<CopySettings>>('copy', {}) });
export const setCopySetting = (key: keyof CopySettings, value: number) =>
  setSetting('copy', { ...getSetting('copy', {}), [key]: value });
