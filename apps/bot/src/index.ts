import { botConnection, botKeypair, checkBotDeposits, networkBanner } from './botWallet.ts';
import { config } from './config.ts';
import { formatDuration } from './format.ts';
import { connection } from './solana.ts';
import { loadState, saveState } from './state.ts';
import { COMMANDS, createBot } from './telegram.ts';
import { failingJobs, healthFailed, healthOk } from './health.ts';
import { autopilotTick, getAutopilot } from './trading/autopilot.ts';
import { pruneCandles } from './trading/candles.ts';
import { getTournament, tournamentTick } from './trading/tournament.ts';
import { runStrategies } from './trading/engine.ts';
import { scheduledMessages } from './trading/performance.ts';
import { pollWhales } from './trading/whales.ts';
import { ensurePaperAccount } from './trading/store.ts';
import { checkWallet } from './watcher.ts';

const startedAt = Date.now();
const state = loadState();
ensurePaperAccount();

// What happened before this start, captured before the heartbeat overwrites it.
const downtime = state.lastSeenAt ? startedAt - state.lastSeenAt : undefined;
const wasCleanShutdown = state.cleanShutdown === true;
state.cleanShutdown = false;

const time = (ms: number) => new Date(ms).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

async function status(): Promise<string> {
  let rpc = '✅ Solana RPC reachable';
  try {
    await connection.getSlot();
  } catch {
    rpc = '❌ Solana RPC unreachable';
  }
  return [
    '🟢 Online',
    `Up for ${formatDuration(Date.now() - startedAt)} (since ${time(startedAt)})`,
    downtime !== undefined ? `Last downtime: ${formatDuration(downtime)}` : 'First run',
    rpc,
    config.phantomAddress ? '👀 Watching your Phantom wallet' : '⚠️ No Phantom address set (OWNER_PHANTOM_ADDRESS)',
    botKeypair ? `🤖 Bot wallet ${botKeypair.publicKey.toBase58()} · ${networkBanner}${await botRpcHealth()}` : '🤖 No bot wallet yet (npm run wallet:create)',
    `Autopilot: ${getAutopilot().enabled ? 'on' : 'off'} · Tournament: ${getTournament().enabled ? 'on' : 'off'}`,
    failingJobs().length ? `⚠️ Failing: ${failingJobs().join(', ')}` : '✅ All background jobs healthy',
  ].join('\n');
}

async function botRpcHealth(): Promise<string> {
  try {
    await botConnection.getSlot();
    return '';
  } catch {
    return ' ❌ RPC unreachable';
  }
}

const notifyOwner = (text: string) =>
  config.ownerId !== undefined
    ? bot.api.sendMessage(config.ownerId, text.slice(0, 4000), { link_preview_options: { is_disabled: true } }).catch((err) => console.error('Telegram send failed:', err.message))
    : undefined;
const bot = createBot(startedAt, status, notifyOwner);

/** Wraps a background job: runs it, forwards its messages, and alerts on repeated failures. */
async function runJob(job: string, fn: () => Promise<string[] | string | null>) {
  try {
    const result = await fn();
    for (const message of Array.isArray(result) ? result : result ? [result] : []) await notifyOwner(message);
    const recovered = healthOk(job);
    if (recovered) await notifyOwner(recovered);
  } catch (err) {
    console.warn(`${job} failed:`, (err as Error).message);
    const alert = healthFailed(job, err);
    if (alert) await notifyOwner(alert);
  }
}

// Fails fast on a bad token or no network; systemd restarts us and we try again.
await bot.init();
console.log(`Logged in to Telegram as @${bot.botInfo.username}`);

if (botKeypair) console.log(`Bot wallet: ${botKeypair.publicKey.toBase58()} (${config.botWallet.network})`);

if (config.ownerId === undefined) {
  console.log('No TELEGRAM_OWNER_ID set: running in SETUP MODE. Send /start to the bot to get your ID.');
} else {
  await bot.api.setMyCommands(COMMANDS);

  // Tell the owner we're back and what we missed.
  const lines =
    downtime === undefined
      ? ['👋 Buttonwood is online for the first time. Send /help to see what I can do.']
      : [
          `🟢 Back online. I was offline for ${formatDuration(downtime)} (since ${time(state.lastSeenAt!)}).`,
          wasCleanShutdown ? 'Reason: normal shutdown or restart.' : '⚠️ Reason: unexpected stop (crash, power loss, or network outage).',
        ];
  try {
    const missed = await checkWallet(state, 'catch-up');
    if (downtime !== undefined && config.phantomAddress) lines.push('', missed ?? '✅ No new activity on your Phantom wallet while I was offline.');
  } catch (err) {
    lines.push('', `⚠️ Couldn't check your wallet for missed activity: ${(err as Error).message}`);
  }
  try {
    const deposits = await checkBotDeposits(state, 'catch-up');
    if (deposits) lines.push('', deposits);
  } catch (err) {
    lines.push('', `⚠️ Couldn't check the bot wallet for missed deposits: ${(err as Error).message}`);
  }
  await notifyOwner(lines.join('\n'));
}

// Trading engine: runs every enabled strategy once a minute. The first tick runs now,
// so DCA buys that came due while the bot was offline happen right away (once, not N times).
let ticking = false;
async function engineTick() {
  if (ticking || config.ownerId === undefined) return;
  ticking = true;
  await runJob('Trading engine', runStrategies);
  await runJob('Daily report', scheduledMessages);
  ticking = false;
}
await engineTick();
const engineTimer = setInterval(engineTick, config.engineMs);

// Whale following: separate, faster loop. Copy delay is the main cost of following, so poll often.
let polling = false;
async function whaleTick() {
  if (polling || config.ownerId === undefined) return;
  polling = true;
  await runJob('Whale following', pollWhales);
  polling = false;
}
await whaleTick();
const whaleTimer = setInterval(whaleTick, config.whaleMs);

// Autopilot: checks every 10 minutes whether a whale scan is due. First check 2 minutes after startup.
const autopilotJob = () => runJob('Autopilot', () => autopilotTick());
const autopilotStart = setTimeout(autopilotJob, 2 * 60_000);
const autopilotTimer = setInterval(autopilotJob, 10 * 60_000);

// Strategy tournament: seeds itself when empty, rebalances capital weekly. First check 5 minutes after startup.
const tournamentJob = () => runJob('Strategy tournament', async () => {
  pruneCandles();
  return tournamentTick();
});
const tournamentStart = setTimeout(tournamentJob, 5 * 60_000);
const tournamentTimer = setInterval(tournamentJob, 15 * 60_000);

// Heartbeat: lets the next start work out how long we were down.
state.lastSeenAt = Date.now();
saveState(state);
const heartbeat = setInterval(() => {
  state.lastSeenAt = Date.now();
  saveState(state);
}, config.heartbeatMs);

// Live wallet watching while online.
let checking = false;
const walletTimer = setInterval(async () => {
  if (checking || config.ownerId === undefined) return;
  checking = true;
  await runJob('Phantom wallet watching', async () => {
    const news = await checkWallet(state, 'live');
    if (news) saveState(state);
    return news;
  });
  await runJob('Bot wallet deposit check', () => checkBotDeposits(state, 'live'));
  checking = false;
}, config.walletCheckMs);

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down.`);
  clearInterval(heartbeat);
  clearInterval(walletTimer);
  clearInterval(engineTimer);
  clearInterval(whaleTimer);
  clearInterval(autopilotTimer);
  clearTimeout(autopilotStart);
  clearInterval(tournamentTimer);
  clearTimeout(tournamentStart);
  state.lastSeenAt = Date.now();
  state.cleanShutdown = true;
  saveState(state);
  await bot.stop();
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// Long polling. Messages sent while we were offline (kept by Telegram for up to 24h) are delivered now.
await bot.start({
  drop_pending_updates: false,
  onStart: () => console.log('Listening for Telegram messages.'),
});
