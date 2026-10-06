import { Bot, InlineKeyboard, type Context } from 'grammy';
import { formatAmount, usd } from '../format.ts';
import { TRADABLE, findToken, toUi, tokenByMint } from '../tokens.ts';
import { formatOutcome, formatPaperPortfolio, placeOrder } from '../trading/engine.ts';
import * as store from '../trading/store.ts';
import { describeStrategy } from '../trading/strategies.ts';
import type { Limits } from '../trading/types.ts';

export const TRADING_COMMANDS = [
  { command: 'paper', description: 'Paper portfolio: value, PnL, positions' },
  { command: 'buy', description: 'Paper buy: /buy SOL 10  (USD)' },
  { command: 'sell', description: 'Paper sell: /sell SOL 50  (% of position)' },
  { command: 'dca', description: 'New DCA: /dca SOL 5 24  ($5 every 24h)' },
  { command: 'tpsl', description: 'Take-profit/stop-loss: /tpsl SOL 15 8' },
  { command: 'strategies', description: 'List, pause, delete strategies' },
  { command: 'history', description: 'Recent paper trades' },
  { command: 'limits', description: 'Risk limits: /limits maxtrade 25' },
  { command: 'stop', description: '🛑 Stop all trading' },
  { command: 'resume', description: 'Resume trading' },
];

export const TRADING_HELP = [
  '📄 Paper trading (fake money, real prices)',
  '/paper: portfolio and PnL · /paper reset 1000',
  '/buy SOL 10: buy $10 of SOL',
  '/sell SOL 50: sell 50% of your SOL (default 100%)',
  '/dca SOL 5 24: buy $5 of SOL every 24 hours',
  '/tpsl SOL 15 8: sell all SOL at +15% or −8% vs your average entry (0 = off)',
  '/strategies · /history · /limits',
  '/stop: 🛑 stop everything · /resume',
  `Tokens: ${TRADABLE.map((t) => t.symbol).join(', ')}`,
];

const LIMIT_KEYS: Record<string, { key: keyof Limits; label: string; min: number; max: number }> = {
  maxtrade: { key: 'maxTradeUsd', label: 'Max trade size ($)', min: 1, max: 100_000 },
  maxpos: { key: 'maxPositionPct', label: 'Max in one token (% of portfolio)', min: 1, max: 100 },
  dailyloss: { key: 'maxDailyLossPct', label: 'Daily loss limit (%)', min: 0.5, max: 100 },
  trades: { key: 'maxTradesPerHour', label: 'Max trades per hour', min: 1, max: 100 },
  deviation: { key: 'maxPriceDeviationPct', label: 'Max quote vs market price gap (%)', min: 0.1, max: 10 },
  slippage: { key: 'slippageBps', label: 'Slippage (bps, 50 = 0.5%)', min: 1, max: 300 },
};

const unknownToken = (input: string) =>
  `I don't trade "${input}". Allowed: ${TRADABLE.map((t) => t.symbol).join(', ')}`;

function args(ctx: Context): string[] {
  return (typeof ctx.match === 'string' ? ctx.match : '').trim().split(/\s+/).filter(Boolean);
}

function num(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const value = Number(text.replace(',', '.').replace(/[$%]/g, ''));
  return Number.isFinite(value) ? value : undefined;
}

export function registerTradingCommands(bot: Bot, startedAt: number) {
  // Trading commands sent while the bot was offline are refused: prices have moved since.
  const refuseIfStale = async (ctx: Context) => {
    const date = ctx.message?.date;
    if (date !== undefined && date * 1000 < startedAt) {
      await ctx.reply('⛔ This trade was sent while I was offline and prices have moved since. Send it again if you still want it.');
      return true;
    }
    return false;
  };

  bot.command('paper', async (ctx) => {
    const [sub, amount] = args(ctx);
    if (sub?.toLowerCase() === 'reset') {
      const startUsd = num(amount) ?? store.DEFAULT_PAPER_USD;
      if (startUsd < 10 || startUsd > 10_000_000) return ctx.reply('Usage: /paper reset 1000  (between $10 and $10M)');
      return ctx.reply(`Reset the paper account to ${usd(startUsd)}? This deletes all paper positions and paper trade history.`, {
        reply_markup: new InlineKeyboard().text('♻️ Reset', `paper:reset:${startUsd}`).text('Cancel', 'paper:cancel'),
      });
    }
    await ctx.replyWithChatAction('typing');
    await ctx.reply(await formatPaperPortfolio());
  });

  bot.callbackQuery(/^paper:reset:([\d.]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (Date.now() / 1000 - (ctx.callbackQuery.message?.date ?? 0) > 120) return ctx.editMessageText('⌛ Expired. Send /paper reset again.');
    store.resetPaper(Number(ctx.match[1]));
    await ctx.editMessageText(`♻️ Paper account reset to ${usd(Number(ctx.match[1]))}. Strategies are kept; DCA schedules restart now.`);
  });
  bot.callbackQuery('paper:cancel', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('Cancelled.');
  });

  bot.command('buy', async (ctx) => {
    if (await refuseIfStale(ctx)) return;
    const [symbol, amount] = args(ctx);
    const token = symbol ? findToken(symbol) : undefined;
    const usdAmount = num(amount);
    if (!symbol || usdAmount === undefined || usdAmount <= 0) return ctx.reply('Usage: /buy SOL 10  (spend $10 of paper cash on SOL)');
    if (!token || !TRADABLE.includes(token)) return ctx.reply(unknownToken(symbol));
    await ctx.replyWithChatAction('typing');
    const outcome = await placeOrder({ side: 'buy', token, amount: usdAmount, strategyId: null, reason: 'Manual buy (/buy)' });
    await ctx.reply(formatOutcome(outcome));
  });

  bot.command('sell', async (ctx) => {
    if (await refuseIfStale(ctx)) return;
    const [symbol, pctText] = args(ctx);
    const token = symbol ? findToken(symbol) : undefined;
    const pct = pctText === undefined ? 100 : num(pctText);
    if (!symbol || pct === undefined || pct <= 0 || pct > 100) return ctx.reply('Usage: /sell SOL 50  (sell 50% of your paper SOL; default 100%)');
    if (!token) return ctx.reply(`I don't know "${symbol}". Use the symbol from /paper or the token's mint address.`);
    await ctx.replyWithChatAction('typing');
    const outcome = await placeOrder({ side: 'sell', token, amount: pct / 100, strategyId: null, reason: `Manual sell of ${pct}% (/sell)` });
    await ctx.reply(formatOutcome(outcome));
  });

  bot.command('dca', async (ctx) => {
    const [symbol, amount, hours] = args(ctx);
    const token = symbol ? findToken(symbol) : undefined;
    const usdAmount = num(amount);
    const everyHours = num(hours);
    if (!symbol || !usdAmount || usdAmount <= 0 || !everyHours || everyHours < 0.25) {
      return ctx.reply('Usage: /dca SOL 5 24  (buy $5 of SOL every 24 hours; minimum every 0.25h)');
    }
    if (!token || !TRADABLE.includes(token)) return ctx.reply(unknownToken(symbol));
    const id = store.addStrategy('dca', { mint: token.mint, usd: usdAmount, everyHours });
    await ctx.reply(`✅ Strategy #${id} added: buy ${usd(usdAmount)} of ${token.symbol} every ${everyHours}h.\nThe first buy happens within a minute. /strategies to manage.`);
  });

  bot.command('tpsl', async (ctx) => {
    const [symbol, tp, sl] = args(ctx);
    const token = symbol ? findToken(symbol) : undefined;
    const takeProfitPct = num(tp);
    const stopLossPct = num(sl);
    if (!symbol || takeProfitPct === undefined || stopLossPct === undefined || takeProfitPct < 0 || stopLossPct < 0 || stopLossPct >= 100 || (takeProfitPct === 0 && stopLossPct === 0)) {
      return ctx.reply('Usage: /tpsl SOL 15 8  (sell all SOL at +15% or −8% vs your average entry price; use 0 to turn one off)');
    }
    if (!token || !TRADABLE.includes(token)) return ctx.reply(unknownToken(symbol));
    const id = store.addStrategy('tpsl', { mint: token.mint, takeProfitPct, stopLossPct });
    const row = store.listStrategies().find((s) => s.id === id)!;
    await ctx.reply(`✅ Strategy #${id} added: ${describeStrategy(row)}.\nChecked every minute while you hold ${token.symbol}.`);
  });

  const strategiesView = () => {
    const strategies = store.listStrategies();
    if (strategies.length === 0) return { text: 'No strategies yet. Try /dca SOL 5 24 or /tpsl SOL 15 8.', keyboard: undefined };
    const keyboard = new InlineKeyboard();
    const lines = strategies.map((s) => {
      keyboard
        .text(s.enabled ? `⏸ Pause #${s.id}` : `▶️ Resume #${s.id}`, `st:${s.id}:${s.enabled ? 'pause' : 'resume'}`)
        .text(`🗑 Delete #${s.id}`, `st:${s.id}:delete`)
        .row();
      const last = s.type === 'dca' && s.state.lastRunAt
        ? `, last buy ${new Date(s.state.lastRunAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}`
        : '';
      return `${s.enabled ? '🟢' : '⚪️'} #${s.id} ${describeStrategy(s)}${last}`;
    });
    const header = store.isStopped() ? '⏸ All trading is STOPPED (/resume)\n\n' : '';
    return { text: `${header}Strategies\n\n${lines.join('\n')}`, keyboard };
  };

  bot.command('strategies', async (ctx) => {
    const { text, keyboard } = strategiesView();
    await ctx.reply(text, keyboard ? { reply_markup: keyboard } : {});
  });

  bot.callbackQuery(/^st:(\d+):(pause|resume|delete)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const action = ctx.match[2];
    const changed = action === 'delete' ? store.deleteStrategy(id) : store.setStrategyEnabled(id, action === 'resume');
    await ctx.answerCallbackQuery(changed ? { text: `#${id} ${action === 'delete' ? 'deleted' : action === 'pause' ? 'paused' : 'resumed'}` } : { text: 'Already gone' });
    const { text, keyboard } = strategiesView();
    await ctx.editMessageText(text, keyboard ? { reply_markup: keyboard } : {}).catch(() => undefined);
  });

  bot.command('history', async (ctx) => {
    const trades = store.recentTrades(10);
    if (trades.length === 0) return ctx.reply('No trades yet. Try /buy SOL 10 or /dca SOL 5 24.');
    const lines = trades.map((t) => {
      const token = tokenByMint(t.mint);
      const when = new Date(t.createdAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
      const amount = `${formatAmount(toUi(t.tokenRaw, token?.decimals ?? 0))} ${token?.symbol ?? '?'}`;
      const pnl = t.side === 'sell' ? ` · PnL ${t.realizedPnl >= 0 ? '+' : '−'}${usd(Math.abs(t.realizedPnl))}` : '';
      const source = t.strategyId === null ? 'manual' : `#${t.strategyId}`;
      return `${t.side === 'buy' ? '🟢' : '🔴'} ${when} ${t.side.toUpperCase()} ${amount} for ${usd(t.usd)}${pnl} (${source})`;
    });
    await ctx.reply(`📄 Recent paper trades\n\n${lines.join('\n')}`);
  });

  bot.command('limits', async (ctx) => {
    const [name, valueText] = args(ctx);
    if (name) {
      const spec = LIMIT_KEYS[name.toLowerCase()];
      const value = num(valueText);
      if (!spec || value === undefined) {
        return ctx.reply(`Usage: /limits <name> <value>\nNames: ${Object.keys(LIMIT_KEYS).join(', ')}`);
      }
      if (value < spec.min || value > spec.max) return ctx.reply(`${spec.label} must be between ${spec.min} and ${spec.max}.`);
      store.setLimit(spec.key, value);
    }
    const limits = store.getLimits();
    const lines = Object.entries(LIMIT_KEYS).map(([n, spec]) => `${spec.label}: ${limits[spec.key]}   (/limits ${n} …)`);
    await ctx.reply(`🛡 Risk limits\n\n${lines.join('\n')}\n\nSells (incl. stop-losses) are never blocked by size or daily-loss limits.`);
  });

  bot.command('stop', async (ctx) => {
    store.setStopped(true);
    await ctx.reply('🛑 All trading STOPPED. Strategies are paused and manual trades are blocked. This survives restarts.\n/resume to continue.');
  });

  bot.command('resume', async (ctx) => {
    store.setStopped(false);
    await ctx.reply('▶️ Trading resumed. Note: overdue DCA buys will run once within a minute.');
  });
}
