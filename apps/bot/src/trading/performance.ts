import { usd } from '../format.ts';
import { SOL_MINT } from '../tokens.ts';
import { fetchPrices, valuePortfolio } from './engine.ts';
import * as store from './store.ts';
import { describeStrategy } from './strategies.ts';
import { formatWhaleStats, listWhales, whaleStats } from './whales.ts';

const DAY = 86_400_000;

/** The bar paper results must clear before real money is even discussed. */
export const READINESS = {
  minDays: 14,
  minTrades: 30,
  minClosedTrades: 10,
  maxDrawdownPct: 15,
};

/** Largest peak-to-trough drop of the equity curve, in %. Pure. */
export function maxDrawdownPct(values: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) worst = Math.max(worst, ((peak - v) / peak) * 100);
  }
  return worst;
}

/** Average compounded daily return in %, given a total growth factor over `days`. Pure. */
export function avgDailyReturnPct(startUsd: number, endUsd: number, days: number): number | null {
  if (days < 1 || startUsd <= 0 || endUsd <= 0) return null;
  return ((endUsd / startUsd) ** (1 / days) - 1) * 100;
}

const signed = (n: number) => (Math.abs(n) < 0.005 ? '$0.00' : `${n > 0 ? '+' : '−'}${usd(Math.abs(n))}`);
const pct = (n: number, d = 2) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(d)}%`;

export async function snapshot() {
  const prices = await fetchPrices();
  const { totalUsd } = valuePortfolio(store.getPositions(), prices);
  const startUsd = store.getSetting('paper_start_usd', store.DEFAULT_PAPER_USD);
  const startAt = store.getSetting('paper_start_at', Date.now());
  const days = (Date.now() - startAt) / DAY;
  const startSol = store.getSetting<number | null>('paper_start_sol_price', null);
  const solNow = prices.get(SOL_MINT);
  const holdSolPct = startSol && solNow ? (solNow / startSol - 1) * 100 : null;
  const trades = store.allTrades();
  const sells = trades.filter((t) => t.side === 'sell');
  const equity = [...store.equityHistory().map((e) => e.valueUsd), totalUsd];
  return {
    prices, totalUsd, startUsd, startAt, days, holdSolPct, trades, sells,
    returnPct: (totalUsd / startUsd - 1) * 100,
    feesUsd: trades.reduce((sum, t) => sum + t.feeUsd, 0),
    wins: sells.filter((t) => t.realizedPnl > 0).length,
    drawdownPct: maxDrawdownPct(equity),
    dailyPct: avgDailyReturnPct(startUsd, totalUsd, days),
  };
}

export function readiness(s: Awaited<ReturnType<typeof snapshot>>) {
  const checks = [
    { ok: s.days >= READINESS.minDays, text: `${READINESS.minDays}+ days of paper trading (${s.days.toFixed(1)})` },
    { ok: s.trades.length >= READINESS.minTrades, text: `${READINESS.minTrades}+ trades (${s.trades.length})` },
    { ok: s.sells.length >= READINESS.minClosedTrades, text: `${READINESS.minClosedTrades}+ closed trades (${s.sells.length})` },
    { ok: s.returnPct > 0, text: `profitable after fees (${pct(s.returnPct)})` },
    { ok: s.holdSolPct !== null && s.returnPct > s.holdSolPct, text: `beats just holding SOL (${s.holdSolPct === null ? 'n/a' : pct(s.holdSolPct)})` },
    { ok: s.drawdownPct <= READINESS.maxDrawdownPct, text: `worst drop under ${READINESS.maxDrawdownPct}% (${s.drawdownPct.toFixed(1)}%)` },
  ];
  return { checks, ready: checks.every((c) => c.ok) };
}

export async function formatPerformance(): Promise<string> {
  const s = await snapshot();
  const lines = [
    '📊 Performance (paper, fees included)',
    `Value ${usd(s.totalUsd)} · ${pct(s.returnPct)} over ${s.days.toFixed(1)} days`,
    `Avg per day: ${s.dailyPct === null ? 'need 1+ day of data' : pct(s.dailyPct, 3)}`,
    `Just holding SOL: ${s.holdSolPct === null ? 'n/a yet' : pct(s.holdSolPct)}`,
    `Worst drop from a peak: ${s.drawdownPct.toFixed(1)}%`,
    `Trades: ${s.trades.length} · closed ${s.sells.length}${s.sells.length ? ` · win rate ${Math.round((s.wins / s.sells.length) * 100)}%` : ''} · fees ${usd(s.feesUsd)}`,
  ];

  // Realized PnL per source
  const bySource = new Map<string, { realized: number; fees: number; count: number }>();
  const strategies = new Map(store.listStrategies().map((st) => [st.id, st]));
  const whales = listWhales();
  for (const t of s.trades) {
    const key = t.whale
      ? `🐋 ${whales.find((w) => w.address === t.whale)?.label ?? t.whale.slice(0, 4)}`
      : t.strategyId !== null
        ? `#${t.strategyId} ${strategies.has(t.strategyId) ? describeStrategy(strategies.get(t.strategyId)!) : '(deleted)'}`
        : '✋ manual';
    const entry = bySource.get(key) ?? { realized: 0, fees: 0, count: 0 };
    entry.realized += t.realizedPnl;
    entry.fees += t.feeUsd;
    entry.count += 1;
    bySource.set(key, entry);
  }
  if (bySource.size) {
    lines.push('', 'Realized by source:');
    for (const [key, v] of bySource) lines.push(`• ${key}: ${signed(v.realized - v.fees)} (${v.count} trades)`);
  }

  if (whales.length) {
    lines.push('', 'Whales:');
    for (const w of whales) lines.push(formatWhaleStats(w, await whaleStats(w.address, s.prices)));
  }
  return lines.join('\n');
}

export async function formatReadiness(): Promise<string> {
  const { checks, ready } = readiness(await snapshot());
  return [
    ready ? '✅ Paper record meets the bar for a small live test.' : '🚦 Not ready for real money yet',
    '',
    ...checks.map((c) => `${c.ok ? '✅' : '❌'} ${c.text}`),
    '',
    ready
      ? 'Next: live trading is a separate step you switch on yourself, starting with a small amount and tight limits.'
      : 'These are checked automatically. I\'ll message you the moment all of them pass.',
  ].join('\n');
}

const REPORT_HOUR_UTC = Number(process.env.REPORT_HOUR_UTC ?? 20);

/** Once a day after REPORT_HOUR_UTC: the daily report, plus a one-time note when readiness passes. */
export async function scheduledMessages(): Promise<string[]> {
  const messages: string[] = [];
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCHours() >= REPORT_HOUR_UTC && store.getSetting('last_report_date', '') !== today) {
    store.setSetting('last_report_date', today);
    messages.push(await formatDailyReport());
  }
  if (!store.getSetting('readiness_notified', false)) {
    const { ready } = readiness(await snapshot());
    if (ready) {
      store.setSetting('readiness_notified', true);
      messages.push(`🎓 ${await formatReadiness()}`);
    }
  }
  return messages;
}

export async function formatDailyReport(): Promise<string> {
  const s = await snapshot();
  const since = Date.now() - DAY;
  const today = s.trades.filter((t) => t.createdAt >= since);
  const realizedToday = today.reduce((sum, t) => sum + t.realizedPnl - t.feeUsd, 0);
  const yesterday = store.equityHistory().filter((e) => e.ts <= since).at(-1)?.valueUsd;
  const dayChange = yesterday ? (s.totalUsd / yesterday - 1) * 100 : null;
  const { checks } = readiness(s);
  const best = today.filter((t) => t.side === 'sell').sort((a, b) => b.realizedPnl - a.realizedPnl);
  return [
    `🗓 Daily report · paper`,
    `Value ${usd(s.totalUsd)} (${dayChange === null ? 'first day' : `${pct(dayChange)} in 24h`}) · ${pct(s.returnPct)} since start`,
    `Last 24h: ${today.length} trades, realized ${signed(realizedToday)}`,
    ...(best.length ? [`Best: ${signed(best[0].realizedPnl)} · Worst: ${signed(best.at(-1)!.realizedPnl)}`] : []),
    `Avg per day so far: ${s.dailyPct === null ? 'n/a' : pct(s.dailyPct, 3)} · holding SOL: ${s.holdSolPct === null ? 'n/a' : pct(s.holdSolPct)}`,
    `Go-live checklist: ${checks.filter((c) => c.ok).length}/${checks.length} (/readiness)`,
    '',
    '/performance for the breakdown by strategy and whale',
  ].join('\n');
}
