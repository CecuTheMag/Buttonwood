import { config } from './config.ts';
import { formatChanges } from './format.ts';
import { getHoldings, getNewSignatures } from './solana.ts';
import { saveState, type State } from './state.ts';

const MAX_LINKS = 5;

/**
 * Looks for Phantom wallet transactions the bot hasn't reported yet.
 * Used both on startup (catching up on downtime) and every minute while running.
 * Returns a message to send, or null when there's nothing new.
 */
export async function checkWallet(state: State, mode: 'catch-up' | 'live'): Promise<string | null> {
  const owner = config.phantomAddress;
  if (!owner) return null;
  const address = owner.toBase58();

  // First time watching this address: remember where we are, report nothing.
  if (state.wallet?.address !== address) {
    const [latest] = await getNewSignatures(owner, undefined, 1);
    state.wallet = { address, lastSignature: latest?.signature, snapshot: await getHoldings(owner) };
    saveState(state);
    return null;
  }

  const signatures = await getNewSignatures(owner, state.wallet.lastSignature);
  if (signatures.length === 0) return null;

  const holdings = await getHoldings(owner);
  const changes = formatChanges(state.wallet.snapshot ?? {}, holdings);
  const count = signatures.length >= 25 ? '25+' : String(signatures.length);
  const failed = signatures.filter((s) => s.err).length;

  const lines = [
    mode === 'catch-up'
      ? `📬 While I was offline, ${count} transaction(s) happened on your Phantom wallet.`
      : `🔔 New activity on your Phantom wallet (${count} transaction(s)).`,
  ];
  if (failed) lines.push(`${failed} of them failed.`);
  lines.push('', changes.length ? `Balance changes:\n${changes.join('\n')}` : 'No balance changes.');
  lines.push('', ...signatures.slice(0, MAX_LINKS).map((s) => {
    const when = s.blockTime ? new Date(s.blockTime * 1000).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '?';
    return `${s.err ? '❌' : '✅'} ${when}  https://solscan.io/tx/${s.signature}`;
  }));
  if (signatures.length > MAX_LINKS) lines.push(`…and more: https://solscan.io/account/${address}`);

  state.wallet.lastSignature = signatures[0].signature;
  state.wallet.snapshot = holdings;
  return lines.join('\n');
}
