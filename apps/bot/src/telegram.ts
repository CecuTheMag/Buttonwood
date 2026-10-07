import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import {
  NO_WALLET_MESSAGE,
  botKeypair,
  explorerTx,
  getBotBalance,
  isDevnet,
  networkBanner,
  planWithdrawal,
  requestAirdrop,
  sol,
  withdrawSol,
} from './botWallet.ts';
import { TRADING_COMMANDS, TRADING_HELP, registerTradingCommands } from './commands/trading.ts';
import { WHALE_COMMANDS, WHALE_HELP, registerWhaleCommands } from './commands/whales.ts';
import { config } from './config.ts';
import { recentTransfers } from './db.ts';
import { formatPortfolio } from './format.ts';
import { getUsdPrices } from './prices.ts';
import { getHoldings } from './solana.ts';

export const COMMANDS = [
  ...TRADING_COMMANDS,
  ...WHALE_COMMANDS,
  { command: 'balance', description: 'Phantom + bot wallet balances' },
  { command: 'fund', description: 'Add SOL to the bot wallet from Phantom' },
  { command: 'withdraw', description: 'Send SOL back to Phantom: /withdraw or /withdraw 0.1' },
  { command: 'transfers', description: 'Recent deposits and withdrawals' },
  ...(isDevnet ? [{ command: 'airdrop', description: 'Get 1 free devnet SOL (test money)' }] : []),
  { command: 'status', description: 'Is the bot healthy? Uptime and last downtime' },
  { command: 'help', description: 'What I can do' },
];

const HELP = [
  '🌳 Buttonwood (paper trading + whale following)',
  '',
  ...TRADING_HELP,
  '',
  ...WHALE_HELP,
  '',
  `👛 Wallets · bot wallet on ${networkBanner}`,
  '/balance: your Phantom wallet and the bot wallet',
  '/fund: QR code to send SOL from Phantom to the bot',
  '/withdraw: send everything back to Phantom (or /withdraw 0.1)',
  '/transfers: recent deposits and withdrawals',
  ...(isDevnet ? ['/airdrop: 1 free devnet SOL for testing'] : []),
  '/status: uptime, last downtime, connection health',
  '',
  'Withdrawals only ever go to your Phantom address. I message you about wallet activity, and after downtime I tell you what you missed.',
].join('\n');

const CONFIRM_TTL_MS = 2 * 60_000;
const pendingWithdrawals = new Map<string, { amount: number | 'all'; createdAt: number }>();

const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

/** "0.5" → lamports, or undefined if it isn't a positive SOL amount. */
function parseSol(text: string): number | undefined {
  const value = Number(text.trim().replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value * LAMPORTS_PER_SOL);
}

/**
 * True if the message was sent before this process started, i.e. while the bot was offline.
 * Commands that move money must refuse these and ask again, never act on them.
 */
export function sentWhileOffline(ctx: Context, startedAt: number): boolean {
  const date = ctx.message?.date;
  return date !== undefined && date * 1000 < startedAt;
}

export function createBot(startedAt: number, status: () => Promise<string>, notify: (text: string) => unknown): Bot {
  const bot = new Bot(config.telegramToken);
  bot.catch((err) => console.error('Telegram handler error:', err.error));

  // Setup mode: no owner configured yet. Only tell people their ID; do nothing else.
  if (config.ownerId === undefined) {
    bot.on('message', async (ctx) => {
      console.log(`[setup] message from user ${ctx.from.id} (@${ctx.from.username ?? 'no username'})`);
      await ctx.reply(
        `👋 Buttonwood is in setup mode.\n\nYour Telegram user ID is: ${ctx.from.id}\n\n` +
        `Put this line in the bot's .env file, then restart the bot:\nTELEGRAM_OWNER_ID=${ctx.from.id}\n\n` +
        `After that I will only answer you.`,
      );
    });
    return bot;
  }

  // 🔒 Bots are public. Silently ignore everyone except the owner.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id === config.ownerId) await next();
  });

  // Messages queued by Telegram while we were offline get delivered on startup. Say so.
  bot.use(async (ctx, next) => {
    if (sentWhileOffline(ctx, startedAt)) {
      const sentAt = new Date(ctx.message!.date * 1000).toLocaleTimeString('en-GB', { timeStyle: 'short' });
      await ctx.reply(`📨 You sent this at ${sentAt} while I was offline. Answering now:`, {
        reply_parameters: { message_id: ctx.message!.message_id },
      });
    }
    await next();
  });

  bot.command(['start', 'help'], (ctx) => ctx.reply(HELP));

  bot.command('balance', async (ctx) => {
    await ctx.replyWithChatAction('typing');
    const sections: string[] = [];

    if (config.phantomAddress) {
      const holdings = await getHoldings(config.phantomAddress);
      const prices = await getUsdPrices(Object.keys(holdings));
      sections.push(`👛 Phantom ${short(config.phantomAddress.toBase58())} (mainnet)\n${formatPortfolio(holdings, prices)}`);
    } else {
      sections.push('👛 Phantom: not set (OWNER_PHANTOM_ADDRESS in .env)');
    }

    if (botKeypair) {
      const lamports = await getBotBalance();
      let line = `${sol(lamports)} SOL`;
      if (!isDevnet) {
        const { SOL: price } = await getUsdPrices(['SOL']);
        if (price) line += `  $${((lamports / LAMPORTS_PER_SOL) * price).toFixed(2)}`;
      }
      sections.push(`🤖 Bot wallet ${short(botKeypair.publicKey.toBase58())} · ${networkBanner}\n${line}`);
    } else {
      sections.push(`🤖 Bot wallet: not created yet`);
    }

    await ctx.reply(sections.join('\n\n'), { link_preview_options: { is_disabled: true } });
  });

  bot.command('fund', async (ctx) => {
    if (!botKeypair) return ctx.reply(NO_WALLET_MESSAGE);
    const lamports = ctx.match ? parseSol(ctx.match) : undefined;
    if (ctx.match && lamports === undefined) return ctx.reply('Usage: /fund  or  /fund 0.5');

    const address = botKeypair.publicKey.toBase58();
    // Solana Pay link: Phantom's scanner fills in the address (and amount) for you
    const params = new URLSearchParams({ label: 'Buttonwood bot', message: 'Fund Buttonwood' });
    if (lamports) params.set('amount', String(lamports / LAMPORTS_PER_SOL));
    const png = await QRCode.toBuffer(`solana:${address}?${params}`, { width: 512, margin: 2 });

    const caption = [
      `Fund the bot · ${networkBanner}`,
      '',
      '1. In Phantom, tap the scan icon and scan this QR code',
      `2. ${lamports ? `Check the amount (${sol(lamports)} SOL)` : 'Enter an amount'} and approve`,
      "3. I'll message you within about a minute when it arrives",
      ...(isDevnet
        ? ['', '🧪 Phantom must be on devnet: Settings → Developer Settings → Testnet Mode ON → Solana: Devnet.',
           'Free devnet SOL: https://faucet.solana.com or /airdrop']
        : []),
      '',
      'Bot address (also sent below so you can copy it):',
      address,
    ].join('\n');

    await ctx.replyWithPhoto(new InputFile(png, 'fund-buttonwood.png'), { caption });
    await ctx.reply(address);
  });

  bot.command('withdraw', async (ctx) => {
    if (sentWhileOffline(ctx, startedAt)) {
      return ctx.reply("⛔ This /withdraw was sent while I was offline. For safety I never act on old money commands. Send it again if you still want it.");
    }
    const arg = ctx.match.trim().toLowerCase();
    let amount: number | 'all' = 'all';
    if (arg && arg !== 'all') {
      const lamports = parseSol(arg);
      if (!lamports) return ctx.reply('Usage: /withdraw  (everything)  or  /withdraw 0.1');
      amount = lamports;
    }

    let plan;
    try {
      plan = await planWithdrawal(amount);
    } catch (err) {
      return ctx.reply(`❌ ${(err as Error).message}`);
    }

    const id = randomBytes(6).toString('hex');
    pendingWithdrawals.set(id, { amount, createdAt: Date.now() });
    await ctx.reply(
      [
        `Withdraw · ${networkBanner}`,
        '',
        `Send ${sol(plan.lamports)} SOL from the bot wallet`,
        `to your Phantom wallet ${short(config.phantomAddress!.toBase58())}?`,
        `Network fee: ${sol(plan.fee)} SOL`,
        '',
        'This button expires in 2 minutes.',
      ].join('\n'),
      { reply_markup: new InlineKeyboard().text('✅ Send', `wd:${id}:yes`).text('Cancel', `wd:${id}:no`) },
    );
  });

  bot.callbackQuery(/^wd:([0-9a-f]+):(yes|no)$/, async (ctx) => {
    const [, id, answer] = ctx.match;
    const pending = pendingWithdrawals.get(id);
    pendingWithdrawals.delete(id); // one tap only: a double tap can't send twice
    await ctx.answerCallbackQuery();

    if (!pending || Date.now() - pending.createdAt > CONFIRM_TTL_MS) {
      return ctx.editMessageText('⌛ This withdrawal expired. Nothing was sent. Send /withdraw again.');
    }
    if (answer === 'no') return ctx.editMessageText('Cancelled. Nothing was sent.');

    await ctx.editMessageText('⏳ Sending…');
    try {
      const { signature, lamports } = await withdrawSol(pending.amount);
      await ctx.editMessageText(`✅ Sent ${sol(lamports)} SOL to your Phantom wallet.\n${explorerTx(signature)}`, {
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      console.error('Withdrawal failed:', err);
      await ctx.editMessageText(`❌ Withdrawal failed: ${(err as Error).message}\nCheck /balance before trying again.`);
    }
  });

  bot.command('airdrop', async (ctx) => {
    if (!isDevnet) return ctx.reply('Airdrops only exist on devnet.');
    if (!botKeypair) return ctx.reply(NO_WALLET_MESSAGE);
    await ctx.reply('🚰 Asking the devnet faucet for 1 SOL…');
    try {
      await requestAirdrop();
      await ctx.reply("✅ Airdrop landed. You'll get the deposit message shortly.");
    } catch (err) {
      await ctx.reply(`❌ The devnet faucet said no (it's often rate-limited): ${(err as Error).message}\nTry https://faucet.solana.com with the bot address from /fund.`);
    }
  });

  bot.command('transfers', async (ctx) => {
    const transfers = recentTransfers(10);
    if (transfers.length === 0) return ctx.reply('No deposits or withdrawals yet. Use /fund to add SOL.');
    const lines = transfers.map((t) => {
      const when = new Date(t.createdAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
      const arrow = t.direction === 'in' ? '⬇️ in ' : '⬆️ out';
      return `${arrow} ${sol(t.amountRaw)} ${t.asset} · ${when} · ${t.network}`;
    });
    await ctx.reply(`Recent transfers\n\n${lines.join('\n')}`);
  });

  bot.command('status', async (ctx) => ctx.reply(await status()));

  registerTradingCommands(bot, startedAt);
  registerWhaleCommands(bot, notify);

  bot.on('message', (ctx) => ctx.reply("I don't know that one yet. Try /help."));

  return bot;
}
