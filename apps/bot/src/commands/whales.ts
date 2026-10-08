import { Bot, InlineKeyboard, type Context } from 'grammy';
import { usd } from '../format.ts';
import { autopilotTick, getAutopilot, isDiscovering, lastDiscoveryAt, setAutopilot } from '../trading/autopilot.ts';
import { DEFAULT_COPY, getCopySettings, setCopySetting, type CopySettings } from '../trading/copySettings.ts';
import { describeScore, recentCandidates } from '../trading/discovery.ts';
import { formatDailyReport, formatPerformance, formatReadiness } from '../trading/performance.ts';
import { addWhale, findWhale, formatWhaleStats, listWhales, removeWhale, setWhaleEnabled, whaleStats } from '../trading/whales.ts';

export const WHALE_COMMANDS = [
  { command: 'autopilot', description: 'Automatic whale finding: on / off / run / whales 5' },
  { command: 'candidates', description: 'Wallets the autopilot scored, and why' },
  { command: 'whale', description: 'Follow a wallet: /whale add <address> <name> [usd]' },
  { command: 'whales', description: 'Followed wallets and how copying them is going' },
  { command: 'copy', description: 'Copy-trading settings: /copy usd 25' },
  { command: 'performance', description: 'Results by strategy and whale, vs holding SOL' },
  { command: 'readiness', description: 'Go-live checklist (evidence, not hope)' },
  { command: 'report', description: 'Daily report now' },
];

export const WHALE_HELP = [
  '🐋 Whale following (paper)',
  '/autopilot: finds, follows and replaces whales by itself (on by default) · /candidates',
  '/whale add <address> <name> [usd per copy]',
  '/whale remove <name>',
  '/whales: results per whale · /copy: settings',
  '/performance · /readiness · /report',
];

const COPY_KEYS: Record<string, { key: keyof CopySettings; label: string; min: number; max: number }> = {
  usd: { key: 'usdPerTrade', label: 'Default $ per copied buy', min: 1, max: 10_000 },
  minwhale: { key: 'minWhaleTradeUsd', label: 'Ignore whale trades under ($)', min: 0, max: 1_000_000 },
  delay: { key: 'maxCopyDelaySec', label: 'Max delay to copy a buy (s)', min: 10, max: 3600 },
  latehours: { key: 'lateCopyMaxHours', label: 'Slow whales: copy buys up to (h) late', min: 0, max: 48 },
  latedrift: { key: 'lateCopyMaxDriftPct', label: 'Slow whales: max price rise since their buy (%)', min: 0, max: 20 },
  liquidity: { key: 'minLiquidityUsd', label: 'Min token liquidity ($)', min: 10_000, max: 1_000_000_000 },
  holders: { key: 'minHolders', label: 'Min token holders', min: 0, max: 10_000_000 },
  tophold: { key: 'maxTopHoldersPct', label: 'Max % held by top holders', min: 5, max: 100 },
  age: { key: 'minAgeHours', label: 'Min token age (h)', min: 0, max: 100_000 },
  roundtrip: { key: 'maxRoundTripLossPct', label: 'Max buy-then-sell loss (%)', min: 0.1, max: 50 },
  stoploss: { key: 'stopLossPct', label: 'Copy stop-loss (%)', min: 1, max: 99 },
  judgeafter: { key: 'autoPauseAfterSells', label: 'Judge a whale after N closed copies', min: 1, max: 1000 },
  pauseloss: { key: 'autoPauseLossPct', label: 'Auto-pause a whale losing more than (%)', min: 0, max: 100 },
};

const args = (ctx: Context) => (typeof ctx.match === 'string' ? ctx.match : '').trim().split(/\s+/).filter(Boolean);

export function registerWhaleCommands(bot: Bot, notify: (text: string) => unknown) {
  bot.command('autopilot', async (ctx) => {
    const [sub, value] = args(ctx);
    const action = sub?.toLowerCase();
    if (action === 'on' || action === 'off') setAutopilot({ enabled: action === 'on' });
    if (action === 'whales') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 20) return ctx.reply('Usage: /autopilot whales 5  (1–20)');
      setAutopilot({ maxWhales: n });
    }
    if (action === 'run') {
      if (isDiscovering()) return ctx.reply('A scan is already running.');
      await ctx.reply('🤖 Scanning now. This takes a few minutes; I\'ll message you the result.');
      autopilotTick(true).then((messages) => messages.forEach((m) => notify(m))).catch((err) => notify(`🤖 Scan failed: ${err.message}`));
      return;
    }
    const s = getAutopilot();
    const last = lastDiscoveryAt();
    const following = listWhales().filter((w) => w.enabled);
    await ctx.reply([
      `🤖 Autopilot: ${s.enabled ? 'ON' : 'OFF'}${isDiscovering() ? ' (scanning now…)' : ''}`,
      `Following ${following.length}/${s.maxWhales} whales (${following.filter((w) => w.auto).length} picked by autopilot)`,
      `Last scan: ${last ? new Date(last).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : 'never'} · full rescan every ${s.discoverEveryHours}h, empty slots refilled after 8h`,
      `Drops whales idle for ${s.inactiveDays} days; auto-pauses losers (see /copy)`,
      '',
      '/autopilot on · off · run · whales <n>',
    ].join('\n'));
  });

  bot.command('candidates', async (ctx) => {
    const list = recentCandidates(10);
    if (list.length === 0) return ctx.reply('No wallets scored yet. /autopilot run to scan now.');
    const lines = list.map((c) =>
      `${c.score.eligible ? '✅' : '❌'} ${c.address.slice(0, 4)}…${c.address.slice(-4)} (${c.foundIn.join(', ')})\n   ${describeScore(c.score)}${c.score.eligible ? '' : `\n   ✗ ${c.score.reasons.join('; ')}`}`);
    await ctx.reply(`🔎 Recently scored wallets\n\n${lines.join('\n\n')}`);
  });

  bot.command('whale', async (ctx) => {
    const [sub, a, b, c] = args(ctx);
    if (sub === 'add' && a) {
      const label = b ?? `whale${listWhales().length + 1}`;
      const size = c ? Number(c) : null;
      if (size !== null && (!Number.isFinite(size) || size <= 0)) return ctx.reply('The $ per copy must be a positive number.');
      try {
        addWhale(a, label, size);
      } catch {
        return ctx.reply("That isn't a valid Solana address.");
      }
      return ctx.reply(
        `🐋 Following ${label} (${a.slice(0, 4)}…${a.slice(-4)}), copying ${usd(size ?? getCopySettings().usdPerTrade)} per buy in PAPER mode.\n` +
        `I copy buys of tokens that pass the safety check, copy their sells, and stop-loss copied positions at −${getCopySettings().stopLossPct}%.\n` +
        `Starts from their next trade. After ${getCopySettings().autoPauseAfterSells} closed copies, I'll pause them automatically if copying them loses money.`,
      );
    }
    if (sub === 'remove' && a) {
      const whale = findWhale(a);
      if (!whale || !removeWhale(whale.address)) return ctx.reply(`No whale called "${a}". See /whales.`);
      return ctx.reply(`Stopped following ${whale.label}. Positions already copied stay in /paper (sell with /sell).`);
    }
    return ctx.reply('Usage:\n/whale add <address> <name> [usd per copy]\n/whale remove <name>');
  });

  const whalesView = async () => {
    const whales = listWhales();
    if (whales.length === 0) return { text: 'Not following anyone yet.\n/whale add <address> <name>', keyboard: undefined };
    const keyboard = new InlineKeyboard();
    const lines: string[] = [];
    for (const w of whales) {
      lines.push(formatWhaleStats(w, await whaleStats(w.address)));
      keyboard.text(w.enabled ? `⏸ ${w.label}` : `▶️ ${w.label}`, `wh:${w.address}:${w.enabled ? 'pause' : 'resume'}`).row();
    }
    return { text: `🐋 Whales (paper)\n\n${lines.join('\n\n')}\n\n"worse price" = what following costs you vs the whale's own fill, after their network fee.`, keyboard };
  };

  bot.command('whales', async (ctx) => {
    await ctx.replyWithChatAction('typing');
    const { text, keyboard } = await whalesView();
    await ctx.reply(text, keyboard ? { reply_markup: keyboard } : {});
  });

  bot.callbackQuery(/^wh:(\w+):(pause|resume)$/, async (ctx) => {
    setWhaleEnabled(ctx.match[1], ctx.match[2] === 'resume', ctx.match[2] === 'pause' ? 'paused by you' : null);
    await ctx.answerCallbackQuery({ text: ctx.match[2] === 'pause' ? 'Paused' : 'Resumed' });
    const { text, keyboard } = await whalesView();
    await ctx.editMessageText(text, keyboard ? { reply_markup: keyboard } : {}).catch(() => undefined);
  });

  bot.command('copy', async (ctx) => {
    const [name, valueText] = args(ctx);
    if (name) {
      const spec = COPY_KEYS[name.toLowerCase()];
      const value = Number(valueText?.replace(',', '.'));
      if (!spec || !Number.isFinite(value)) return ctx.reply(`Usage: /copy <name> <value>\nNames: ${Object.keys(COPY_KEYS).join(', ')}`);
      if (value < spec.min || value > spec.max) return ctx.reply(`${spec.label} must be between ${spec.min} and ${spec.max}.`);
      setCopySetting(spec.key, value);
    }
    const settings = getCopySettings();
    const lines = Object.entries(COPY_KEYS).map(([n, spec]) =>
      `${spec.label}: ${settings[spec.key]}${settings[spec.key] !== DEFAULT_COPY[spec.key] ? ' (changed)' : ''}   /copy ${n}`);
    await ctx.reply(`🐋 Copy-trading settings\n\n${lines.join('\n')}`);
  });

  bot.command('performance', async (ctx) => {
    await ctx.replyWithChatAction('typing');
    await ctx.reply(await formatPerformance());
  });
  bot.command('readiness', async (ctx) => ctx.reply(await formatReadiness()));
  bot.command('report', async (ctx) => {
    await ctx.replyWithChatAction('typing');
    await ctx.reply(await formatDailyReport());
  });
}
