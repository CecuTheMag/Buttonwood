import { Bot, type Context } from 'grammy';
import { usd } from '../format.ts';
import { TRADABLE, findToken } from '../tokens.ts';
import { addSleeveStrategy } from '../trading/sleeves.ts';
import { SLEEVE_STRATEGIES } from '../trading/strategyLib.ts';
import {
  backtestAll, formatBacktestRow, formatStandings, getTournament, isTournamentRunning, runBacktest, setTournament, tournamentTick,
} from '../trading/tournament.ts';
import { getYield, setYield, yieldEarnedUsd } from '../trading/yield.ts';

export const LAB_COMMANDS = [
  { command: 'backtest', description: 'Test a strategy on past prices: /backtest trend SOL 90' },
  { command: 'strategy', description: 'Add trend/grid/rebalance: /strategy trend SOL 200' },
  { command: 'tournament', description: 'Strategies competing for capital: standings, run, on/off' },
  { command: 'yield', description: 'Simulated yield on idle cash and SOL' },
];

export const LAB_HELP = [
  '🧪 Strategy lab',
  '/backtest trend SOL 90 · /backtest all 90',
  '/strategy trend|grid|rebalance SOL 200 [key=value…]',
  '/tournament: standings · /tournament seed · rebalance · on · off',
  '/yield: simulated staking/lending yield',
];

const args = (ctx: Context) => (typeof ctx.match === 'string' ? ctx.match : '').trim().split(/\s+/).filter(Boolean);
const types = Object.keys(SLEEVE_STRATEGIES).join(', ');

/** "fastHours=12 slowHours=48" → { fastHours: 12, slowHours: 48 } (only keys the strategy knows) */
function parseParams(type: string, words: string[]): Record<string, number> {
  const known = Object.keys(SLEEVE_STRATEGIES[type].defaults);
  const params: Record<string, number> = {};
  for (const w of words) {
    const [k, v] = w.split('=');
    const key = known.find((x) => x.toLowerCase() === k?.toLowerCase());
    if (!key || !Number.isFinite(Number(v))) throw new Error(`unknown setting "${w}". ${type} settings: ${known.map((x) => `${x}=${(SLEEVE_STRATEGIES[type].defaults as any)[x]}`).join(' ')}`);
    params[key] = Number(v);
  }
  return params;
}

export function registerLabCommands(bot: Bot, notify: (text: string) => unknown) {
  bot.command('backtest', async (ctx) => {
    const [type, symbol, daysText, ...rest] = args(ctx);
    if (type === 'all') {
      const days = Number(symbol ?? 90);
      if (!Number.isFinite(days) || days < 7 || days > 180) return ctx.reply('Usage: /backtest all 90  (7–180 days)');
      await ctx.reply(`🧪 Backtesting ${types} on ${getTournament().tokens.join(', ')} over ${days} days. A first run downloads price history and takes a few minutes; I'll message the results.`);
      backtestAll(days).then((rows) => notify([
        `🧪 Backtests, last ${days} days (0.3% cost per trade + fees, $100 each)`, '',
        ...rows.slice(0, 15).map((r, i) => `${i + 1}. ${formatBacktestRow(r)}`),
        '', 'Past results don\'t predict future ones; they only rule out ideas that didn\'t even work in the past.',
      ].join('\n'))).catch((err) => notify(`🧪 Backtest failed: ${err.message}`));
      return;
    }
    if (!type || !symbol || !SLEEVE_STRATEGIES[type]) return ctx.reply(`Usage: /backtest <${types}> <TOKEN> [days] [key=value…]\n/backtest all [days]`);
    const days = Number(daysText ?? 90);
    try {
      await ctx.replyWithChatAction('typing');
      const r = await runBacktest(type, symbol, days, parseParams(type, rest));
      const x = r.result;
      await ctx.reply([
        `🧪 ${SLEEVE_STRATEGIES[type].label} on ${r.symbol}, last ${days} days ($100, 0.3% cost per trade + fees)`,
        '',
        `Strategy: ${x.returnPct >= 0 ? '+' : ''}${x.returnPct.toFixed(1)}% · avg ${x.avgDailyPct.toFixed(3)}%/day`,
        `Just holding ${r.symbol}: ${x.holdReturnPct >= 0 ? '+' : ''}${x.holdReturnPct.toFixed(1)}%`,
        `Worst drop: ${x.maxDrawdownPct.toFixed(1)}% · in the market ${Math.round(x.exposurePct)}% of the time`,
        `Trades: ${x.trades} · closed ${x.closedTrades} · wins ${x.closedTrades ? Math.round((x.wins / x.closedTrades) * 100) : 0}%`,
      ].join('\n'));
    } catch (err) {
      await ctx.reply(`🧪 ${(err as Error).message}`);
    }
  });

  bot.command('strategy', async (ctx) => {
    const [type, symbol, budgetText, ...rest] = args(ctx);
    const token = symbol ? findToken(symbol) : undefined;
    const budget = Number(budgetText);
    if (!type || !SLEEVE_STRATEGIES[type] || !symbol || !Number.isFinite(budget) || budget < 10) {
      return ctx.reply(`Usage: /strategy <${types}> <TOKEN> <budget $> [key=value…]\ne.g. /strategy trend SOL 200 fastHours=12 slowHours=48\n(DCA and TP/SL: /dca, /tpsl)`);
    }
    if (!token || !TRADABLE.includes(token)) return ctx.reply(`Strategies trade allowlisted tokens: ${TRADABLE.map((t) => t.symbol).join(', ')}`);
    try {
      const params = parseParams(type, rest);
      await runBacktest(type, token.symbol, 7, params).catch(() => undefined); // downloads warm-up history
      const id = addSleeveStrategy(type as any, token.mint, budget, params);
      await ctx.reply(`✅ Strategy #${id}: ${SLEEVE_STRATEGIES[type].label} on ${token.symbol} with a ${usd(budget)} budget. It decides every minute (trend: every completed hour). /strategies to manage, /tournament to see it compete.`);
    } catch (err) {
      await ctx.reply((err as Error).message);
    }
  });

  bot.command('tournament', async (ctx) => {
    const [sub, value] = args(ctx);
    const action = sub?.toLowerCase();
    if (action === 'on' || action === 'off') setTournament({ enabled: action === 'on' });
    if (action === 'pool') {
      const pct = Number(value);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) return ctx.reply('Usage: /tournament pool 60  (% of the paper account)');
      setTournament({ poolPct: pct });
    }
    if (action === 'seed' || action === 'rebalance') {
      if (isTournamentRunning()) return ctx.reply('Already working on it.');
      await ctx.reply(action === 'seed' ? '🏆 Backtesting every strategy on every token to pick a lineup. A few minutes; I\'ll message you.' : '🏆 Rebalancing capital now…');
      tournamentTick(action).then((m) => m.forEach((x) => notify(x))).catch((err) => notify(`🏆 Failed: ${err.message}`));
      return;
    }
    await ctx.replyWithChatAction('typing');
    await ctx.reply(`${await formatStandings()}\n\n/tournament seed · rebalance · on · off · pool <pct>`);
  });

  bot.command('yield', async (ctx) => {
    const [sub, value] = args(ctx);
    const action = sub?.toLowerCase();
    if (action === 'on' || action === 'off') setYield({ enabled: action === 'on' });
    if (action === 'usdc' || action === 'sol') {
      const pct = Number(value);
      if (!Number.isFinite(pct) || pct < 0 || pct > 20) return ctx.reply('Usage: /yield usdc 4  or  /yield sol 6  (APY %, 0–20)');
      setYield(action === 'usdc' ? { usdcApyPct: pct } : { solApyPct: pct });
    }
    const y = getYield();
    await ctx.reply([
      `💤 Simulated yield: ${y.enabled ? 'ON' : 'OFF'}`,
      `Idle USDC: ${y.usdcApyPct}% a year (as if lent out) · SOL: ${y.solApyPct}% (as if liquid-staked)`,
      `Earned so far: ${usd(yieldEarnedUsd())}`,
      '',
      'Paper only, booked hourly. Real yield would need the funds actually staked or lent.',
      '/yield on · off · usdc <apy> · sol <apy>',
    ].join('\n'));
  });
}
