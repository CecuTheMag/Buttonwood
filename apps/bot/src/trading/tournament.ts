// Strategies compete for paper capital. Evidence decides who gets money.
import { usd } from '../format.ts';
import { TRADABLE, findToken, tokenByMint } from '../tokens.ts';
import { allocate, type Contender } from './allocator.ts';
import { backtest, backtestScore, DEFAULT_BACKTEST, type BacktestResult } from './backtest.ts';
import { ensureHistory, getBars } from './candles.ts';
import { fetchPrices, formatOutcome, placeOrders, valuePortfolio } from './engine.ts';
import { sleeveValue } from './sleeve.ts';
import { addSleeveStrategy, isSleeveRow, sleeveParams, sleeveStats, type SleeveRow } from './sleeves.ts';
import { getPositions, getSetting, listStrategies, saveStrategyState, setSetting, setStrategyEnabled } from './store.ts';
import { SLEEVE_STRATEGIES } from './strategyLib.ts';

export type TournamentSettings = {
  enabled: boolean;
  poolPct: number;          // share of the paper account the tournament manages
  lineup: number;           // how many strategies compete at once
  rebalanceEveryHours: number;
  backtestDays: number;
  tokens: string[];         // symbols the tournament may trade
};

export const DEFAULT_TOURNAMENT: TournamentSettings = {
  enabled: true,
  poolPct: 60,
  lineup: 4,
  rebalanceEveryHours: 168,
  backtestDays: 90,
  tokens: ['SOL', 'JUP', 'WIF', 'BONK', 'JTO', 'RAY'],
};

export const getTournament = (): TournamentSettings => ({ ...DEFAULT_TOURNAMENT, ...getSetting<Partial<TournamentSettings>>('tournament', {}) });
export const setTournament = (patch: Partial<TournamentSettings>) => setSetting('tournament', { ...getSetting('tournament', {}), ...patch });

export type BacktestRow = { type: string; symbol: string; mint: string; result: BacktestResult; score: number };

/** Backtests one strategy on one token, downloading history if needed. */
export async function runBacktest(type: string, symbol: string, days: number, params: Record<string, number> = {}): Promise<BacktestRow> {
  const token = findToken(symbol);
  const def = SLEEVE_STRATEGIES[type];
  if (!token) throw new Error(`unknown token ${symbol}`);
  if (!def) throw new Error(`unknown strategy ${type} (try: ${Object.keys(SLEEVE_STRATEGIES).join(', ')})`);
  const merged = { ...def.defaults, ...params };
  await ensureHistory(token.mint, days + Math.ceil(def.warmupBars(merged) / 24) + 1);
  const bars = getBars(token.mint, days * 24 + def.warmupBars(merged));
  if (bars.length < def.warmupBars(merged) + 48) throw new Error(`not enough price history for ${token.symbol} yet`);
  const result = backtest(def, merged, bars, DEFAULT_BACKTEST);
  return { type, symbol: token.symbol, mint: token.mint, result, score: backtestScore(result) };
}

/** Every strategy × every tournament token. ~1 minute per token for a first download, instant after. */
export async function backtestAll(days: number, onProgress?: (t: string) => void): Promise<BacktestRow[]> {
  const rows: BacktestRow[] = [];
  for (const symbol of getTournament().tokens) {
    onProgress?.(symbol);
    for (const type of Object.keys(SLEEVE_STRATEGIES)) {
      try {
        rows.push(await runBacktest(type, symbol, days));
      } catch (err) {
        console.warn(`Backtest ${type} ${symbol}: ${(err as Error).message}`);
      }
    }
  }
  return rows.sort((a, b) => b.score - a.score);
}

const signedPct = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`;

export function formatBacktestRow(r: BacktestRow): string {
  const x = r.result;
  return `${r.type} ${r.symbol}: ${signedPct(x.returnPct)} vs hold ${signedPct(x.holdReturnPct)} · worst drop ${x.maxDrawdownPct.toFixed(1)}% · ${x.trades} trades · ${x.closedTrades ? Math.round((x.wins / x.closedTrades) * 100) : 0}% wins`;
}

/** Fresh start: backtest everything and enter the best into the tournament. */
async function seed(settings: TournamentSettings, poolUsd: number): Promise<string> {
  const rows = (await backtestAll(settings.backtestDays)).filter((r) => r.result.returnPct > 0 && Number.isFinite(r.score));
  if (rows.length === 0) return `🏆 Tournament: backtested every strategy on ${settings.tokens.join(', ')} over ${settings.backtestDays} days, and none made money after costs. Not entering anything; I'll retry in a week.`;

  // Best first, but diversified: at most one strategy per token and at most half the lineup of one
  // type, so the tournament isn't one bet in disguise (in testing, 4 × "rebalance" topped the list).
  const maxPerType = Math.max(1, Math.ceil(settings.lineup / 2));
  const lineup: BacktestRow[] = [];
  for (const r of rows) {
    if (lineup.length >= settings.lineup) break;
    if (lineup.some((l) => l.mint === r.mint)) continue;
    if (lineup.filter((l) => l.type === r.type).length >= maxPerType) continue;
    lineup.push(r);
  }
  const budgets = allocate(lineup.map((r, i) => ({ id: i, score: r.score, drawdownPct: r.result.maxDrawdownPct })), poolUsd);
  const lines = [`🏆 Tournament started with ${usd(poolUsd)} of paper capital (${settings.poolPct}% of the account).`, `Picked from ${rows.length} profitable backtests (${settings.backtestDays} days, costs included):`, ''];
  lineup.forEach((r, i) => {
    const budget = budgets.get(i) ?? 0;
    if (budget < 1) return;
    addSleeveStrategy(r.type as SleeveRow['type'], r.mint, Math.round(budget * 100) / 100);
    lines.push(`• ${formatBacktestRow(r)}\n   → budget ${usd(budget)}`);
  });
  lines.push('', 'Backtests only earn a place. From now on, capital moves weekly based on live paper results. /tournament for standings.');
  return lines.join('\n');
}

/** Weekly: score each sleeve on live results (blended with a fresh backtest while it's young) and re-split the pool. */
async function rebalanceCapital(settings: TournamentSettings, poolUsd: number): Promise<string> {
  const sleeves = listStrategies().filter(isSleeveRow).filter((s) => s.enabled);
  if (sleeves.length === 0) return '';
  const prices = await fetchPrices(sleeves.map((s) => s.params.mint));
  const contenders: Contender[] = [];
  const notes = new Map<number, string>();
  for (const s of sleeves) {
    const live = sleeveStats(s, prices.get(s.params.mint));
    let score = live.returnPct - 0.5 * live.drawdownPct;
    if (live.days < 7) {
      try {
        const bt = await runBacktest(s.type, tokenByMint(s.params.mint)?.symbol ?? '', 30, sleeveParams(s) as Record<string, number>);
        score = (live.days / 7) * score + (1 - live.days / 7) * bt.score;
      } catch { /* keep live score */ }
    }
    contenders.push({ id: s.id, score, drawdownPct: live.drawdownPct });
    notes.set(s.id, `live ${signedPct(live.returnPct)} over ${live.days.toFixed(1)}d, worst drop ${live.drawdownPct.toFixed(1)}%`);
  }

  const budgets = allocate(contenders, poolUsd);
  const lines = ['🏆 Weekly capital rebalance', ''];
  const exits = [];
  for (const s of sleeves) {
    const target = budgets.get(s.id) ?? 0;
    const value = sleeveValue(s.state.sleeve, prices.get(s.params.mint) ?? 0);
    const label = `#${s.id} ${s.type} ${tokenByMint(s.params.mint)?.symbol}`;
    if (target < 1) {
      setStrategyEnabled(s.id, false);
      saveStrategyState(s.id, { ...s.state, pausedReason: 'benched by the tournament' });
      if (s.state.sleeve.tokens > 0) exits.push(s);
      lines.push(`🪑 ${label}: benched (${notes.get(s.id)})`);
      continue;
    }
    const delta = target - value;
    const sleeve = { ...s.state.sleeve, budgetUsd: target, cashUsd: Math.max(0, s.state.sleeve.cashUsd + delta) };
    saveStrategyState(s.id, { ...s.state, sleeve, invested: s.state.invested + Math.max(0, delta) });
    lines.push(`${delta >= 0 ? '⬆️' : '⬇️'} ${label}: ${usd(value)} → ${usd(target)} (${notes.get(s.id)})`);
  }
  // Benched strategies exit their positions
  if (exits.length) {
    const outcomes = await placeOrders(exits.map((s) => ({
      side: 'sell' as const, token: tokenByMint(s.params.mint)!, amount: 1, strategyId: s.id,
      sellRaw: BigInt(Math.floor(s.state.sleeve.tokens * 10 ** tokenByMint(s.params.mint)!.decimals)),
      reason: 'Benched by the tournament: closing its position',
    })));
    outcomes.forEach((o) => lines.push(formatOutcome(o)));
  }
  return lines.join('\n');
}

let running = false;

/** Checked every few minutes: seeds an empty tournament, rebalances weekly. */
export async function tournamentTick(force: 'seed' | 'rebalance' | null = null): Promise<string[]> {
  const settings = getTournament();
  if ((!settings.enabled && !force) || running) return [];
  const sleeves = listStrategies().filter(isSleeveRow);
  const last = getSetting<number | null>('tournament_last', null);
  const dueSeed = force === 'seed' || (sleeves.filter((s) => s.enabled).length === 0 && (last === null || Date.now() - last > 7 * 86_400_000));
  const dueRebalance = force === 'rebalance' || (!dueSeed && last !== null && Date.now() - last > settings.rebalanceEveryHours * 3_600_000);
  if (!dueSeed && !dueRebalance) return [];

  running = true;
  setSetting('tournament_last', Date.now());
  try {
    const prices = await fetchPrices();
    const poolUsd = (valuePortfolio(getPositions(), prices).totalUsd * settings.poolPct) / 100;
    const message = dueSeed ? await seed(settings, poolUsd) : await rebalanceCapital(settings, poolUsd);
    return message ? [message] : [];
  } finally {
    running = false;
  }
}

export const isTournamentRunning = () => running;

export async function formatStandings(): Promise<string> {
  const sleeves = listStrategies().filter(isSleeveRow);
  if (sleeves.length === 0) return '🏆 No tournament strategies yet. /tournament seed to start one now.';
  const prices = await fetchPrices(sleeves.map((s) => s.params.mint));
  const rows = sleeves
    .map((s) => ({ s, live: sleeveStats(s, prices.get(s.params.mint)) }))
    .sort((a, b) => b.live.returnPct - a.live.returnPct);
  const settings = getTournament();
  const last = getSetting<number | null>('tournament_last', null);
  return [
    `🏆 Tournament standings (${settings.enabled ? 'on' : 'off'}, ${settings.poolPct}% of the account)`,
    '',
    ...rows.map(({ s, live }, i) => {
      const status = s.enabled ? `${i + 1}.` : '🪑';
      const holding = s.state.sleeve.tokens > 0 ? ' · in position' : ' · in cash';
      return `${status} #${s.id} ${s.type} ${tokenByMint(s.params.mint)?.symbol}: ${usd(live.value)} (${signedPct(live.returnPct)}) · worst drop ${live.drawdownPct.toFixed(1)}%${holding}`;
    }),
    '',
    `Next capital rebalance: ${last ? new Date(last + settings.rebalanceEveryHours * 3_600_000).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : 'after the first seed'}`,
  ].join('\n');
}

export const TOURNAMENT_TOKENS_HELP = TRADABLE.map((t) => t.symbol).join(', ');
