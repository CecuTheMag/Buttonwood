// Pure: judges a wallet from its own recent trades. Would copying it have been worth it?

export type TradeEvent = { time: number; side: 'buy' | 'sell'; mint: string; tokenAmount: number; usd: number };

export type ScoreCriteria = {
  minClosed: number;          // completed round trips needed to judge at all
  minWinRate: number;         // 0–1
  minRoiPct: number;          // realized profit / cost of what was sold
  minMedianHoldMin: number;   // faster than this can't be copied with a 20s+ delay
  maxTradesPerDay: number;    // hyperactive = bot or market maker
  minLiquidShare: number;     // share of round trips in tokens liquid enough for us to trade
};

export const DEFAULT_CRITERIA: ScoreCriteria = {
  minClosed: 5,
  minWinRate: 0.5,
  minRoiPct: 5,
  minMedianHoldMin: 10,
  maxTradesPerDay: 60,
  minLiquidShare: 0.5,
};

export type WalletScore = {
  trades: number;
  closed: number;
  wins: number;
  winRate: number;
  realizedUsd: number;
  roiPct: number;
  medianHoldMin: number;
  tradesPerDay: number;
  liquidShare: number;
  eligible: boolean;
  reasons: string[];          // why it's not eligible
  score: number;              // higher = better; 0 if not eligible
};

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** `events` in time order (seconds). Sells of tokens bought before the window are skipped: unknown cost. */
export function scoreWallet(events: TradeEvent[], isLiquid: (mint: string) => boolean, c: ScoreCriteria = DEFAULT_CRITERIA): WalletScore {
  const open = new Map<string, { amount: number; cost: number; openedAt: number }>();
  let closed = 0, wins = 0, realized = 0, closedCost = 0, liquidClosed = 0;
  const holds: number[] = [];

  for (const e of events) {
    const lot = open.get(e.mint) ?? { amount: 0, cost: 0, openedAt: e.time };
    if (e.side === 'buy') {
      if (lot.amount <= 0) lot.openedAt = e.time;
      lot.amount += e.tokenAmount;
      lot.cost += e.usd;
      open.set(e.mint, lot);
      continue;
    }
    if (lot.amount <= 0 || e.tokenAmount <= 0) continue;
    const sold = Math.min(e.tokenAmount, lot.amount);
    const cost = lot.cost * (sold / lot.amount);
    const pnl = e.usd * (sold / e.tokenAmount) - cost;
    closed++;
    if (pnl > 0) wins++;
    realized += pnl;
    closedCost += cost;
    if (isLiquid(e.mint)) liquidClosed++;
    holds.push((e.time - lot.openedAt) / 60);
    lot.amount -= sold;
    lot.cost -= cost;
    if (lot.amount <= lot.amount * 1e-9 || lot.amount < 1e-12) open.delete(e.mint);
    else open.set(e.mint, lot);
  }

  const spanDays = events.length > 1 ? (events.at(-1)!.time - events[0].time) / 86_400 : 0;
  const tradesPerDay = events.length / Math.max(spanDays, 1 / 24);
  const winRate = closed ? wins / closed : 0;
  const roiPct = closedCost > 0 ? (realized / closedCost) * 100 : 0;
  const medianHoldMin = median(holds);
  const liquidShare = closed ? liquidClosed / closed : 0;

  const reasons: string[] = [];
  if (closed < c.minClosed) reasons.push(`only ${closed} closed trades`);
  else {
    if (winRate < c.minWinRate) reasons.push(`win rate ${Math.round(winRate * 100)}%`);
    if (roiPct < c.minRoiPct) reasons.push(`return ${roiPct.toFixed(1)}%`);
    if (medianHoldMin < c.minMedianHoldMin) reasons.push(`holds ${medianHoldMin.toFixed(1)} min (too fast to copy)`);
    if (liquidShare < c.minLiquidShare) reasons.push(`${Math.round(liquidShare * 100)}% in liquid tokens`);
  }
  if (tradesPerDay > c.maxTradesPerDay) reasons.push(`${Math.round(tradesPerDay)} trades/day (bot-like)`);

  const eligible = reasons.length === 0;
  return {
    trades: events.length, closed, wins, winRate, realizedUsd: realized, roiPct, medianHoldMin, tradesPerDay, liquidShare,
    eligible, reasons,
    score: eligible ? (roiPct / 100) * winRate * Math.log2(1 + closed) * liquidShare : 0,
  };
}
