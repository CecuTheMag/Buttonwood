import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { existsSync, readFileSync } from 'node:fs';
import { config } from './config.ts';
import { recordTransfer } from './db.ts';
import { decryptSecretKey, type EncryptedKey } from './keystore.ts';
import { MAX_TX_VERSION } from './solana.ts';
import { saveState, type State } from './state.ts';

const { network } = config.botWallet;
export const isDevnet = network === 'devnet';
export const networkBanner = isDevnet ? '🧪 DEVNET (test money)' : '💵 MAINNET (real money)';
export const botConnection = new Connection(config.botWallet.rpcUrl, 'confirmed');

function loadKeypair(): Keypair | undefined {
  const { file, passphrase } = config.botWallet;
  if (!existsSync(file)) return undefined;
  if (!passphrase) throw new Error(`Found ${file} but BOT_KEY_PASSPHRASE is not set in .env.`);
  const encrypted = JSON.parse(readFileSync(file, 'utf8')) as EncryptedKey;
  const keypair = Keypair.fromSecretKey(decryptSecretKey(encrypted, passphrase));
  if (keypair.publicKey.toBase58() !== encrypted.publicKey) throw new Error(`${file} is corrupted (address mismatch).`);
  return keypair;
}

/** undefined until `npm run wallet:create` has been run. */
export const botKeypair = loadKeypair();

export const NO_WALLET_MESSAGE = 'The bot has no wallet yet. On the server, run: cd ~/buttonwood/apps/bot && npm run wallet:create';

export const explorerTx = (signature: string) => `https://solscan.io/tx/${signature}${isDevnet ? '?cluster=devnet' : ''}`;
export const sol = (lamports: number | bigint) =>
  (Number(lamports) / LAMPORTS_PER_SOL).toLocaleString('en-US', { maximumFractionDigits: 9 });

export async function getBotBalance(): Promise<number> {
  if (!botKeypair) throw new Error(NO_WALLET_MESSAGE);
  return botConnection.getBalance(botKeypair.publicKey);
}

export type WithdrawPlan = { lamports: number; fee: number; balance: number };

/**
 * Works out exactly what a withdrawal would send, or throws a friendly error.
 * The destination is ALWAYS the owner's Phantom address from .env, never anything else.
 */
export async function planWithdrawal(requested: number | 'all'): Promise<WithdrawPlan> {
  if (!botKeypair) throw new Error(NO_WALLET_MESSAGE);
  if (!config.phantomAddress) throw new Error('OWNER_PHANTOM_ADDRESS is not set, so I have nowhere safe to send funds.');

  const balance = await getBotBalance();
  const probe = buildTransfer(1);
  probe.recentBlockhash = (await botConnection.getLatestBlockhash()).blockhash;
  const fee = (await botConnection.getFeeForMessage(probe.compileMessage())).value ?? 5000;

  const lamports = requested === 'all' ? balance - fee : requested;
  if (lamports <= 0) throw new Error(`Nothing to withdraw. The bot wallet has ${sol(balance)} SOL.`);
  if (lamports + fee > balance) {
    throw new Error(`Not enough SOL: you asked for ${sol(lamports)} but the bot has ${sol(balance)} (fee ${sol(fee)}).`);
  }
  // Solana won't leave an account holding less than the rent-exempt minimum (unless it's emptied).
  const remaining = balance - lamports - fee;
  const rentMinimum = await botConnection.getMinimumBalanceForRentExemption(0);
  if (remaining > 0 && remaining < rentMinimum) {
    throw new Error(
      `That would leave ${sol(remaining)} SOL, below Solana's ${sol(rentMinimum)} SOL minimum. Withdraw everything (/withdraw) or a bit less.`,
    );
  }
  return { lamports, fee, balance };
}

function buildTransfer(lamports: number): Transaction {
  return new Transaction({ feePayer: botKeypair!.publicKey }).add(
    SystemProgram.transfer({ fromPubkey: botKeypair!.publicKey, toPubkey: config.phantomAddress!, lamports }),
  );
}

export async function withdrawSol(requested: number | 'all'): Promise<{ signature: string; lamports: number }> {
  const { lamports } = await planWithdrawal(requested); // re-plan at send time: the balance may have changed
  const signature = await sendAndConfirmTransaction(botConnection, buildTransfer(lamports), [botKeypair!]);
  recordTransfer({
    direction: 'out',
    network,
    asset: 'SOL',
    amountRaw: BigInt(lamports),
    decimals: 9,
    counterparty: config.phantomAddress!.toBase58(),
    signature,
    createdAt: Date.now(),
  });
  return { signature, lamports };
}

/** Devnet only: free test SOL from the public faucet (often rate-limited). */
export async function requestAirdrop(lamports = LAMPORTS_PER_SOL): Promise<string> {
  if (!isDevnet) throw new Error('Airdrops only exist on devnet.');
  if (!botKeypair) throw new Error(NO_WALLET_MESSAGE);
  const signature = await botConnection.requestAirdrop(botKeypair.publicKey, lamports);
  const latest = await botConnection.getLatestBlockhash();
  await botConnection.confirmTransaction({ signature, ...latest }, 'confirmed');
  return signature;
}

function describeSender(address: string): string {
  if (address === config.phantomAddress?.toBase58()) return 'your Phantom wallet';
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Finds SOL deposits into the bot wallet that haven't been reported yet,
 * records them, and returns a message (or null). Runs on startup and every minute.
 */
export async function checkBotDeposits(state: State, mode: 'catch-up' | 'live'): Promise<string | null> {
  if (!botKeypair) return null;
  const owner = botKeypair.publicKey;
  const address = owner.toBase58();

  // New wallet (or switched network): start tracking from now.
  if (state.botWallet?.address !== address || state.botWallet.network !== network) {
    const [latest] = await botConnection.getSignaturesForAddress(owner, { limit: 1 });
    state.botWallet = { address, network, lastSignature: latest?.signature };
    saveState(state);
    return null;
  }

  const signatures = await botConnection.getSignaturesForAddress(owner, { until: state.botWallet.lastSignature, limit: 50 });
  if (signatures.length === 0) return null;

  const deposits: string[] = [];
  for (const s of [...signatures].reverse()) { // oldest first
    if (s.err) continue;
    const tx = await botConnection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: MAX_TX_VERSION });
    if (!tx?.meta) continue;
    const keys = tx.transaction.message.accountKeys;
    const index = keys.findIndex((k) => k.pubkey.equals(owner));
    const payer = keys[0].pubkey;
    if (index < 0 || payer.equals(owner)) continue; // the bot's own transactions (withdrawals, later trades)

    const received = tx.meta.postBalances[index] - tx.meta.preBalances[index];
    if (received <= 0) continue;
    recordTransfer({
      direction: 'in',
      network,
      asset: 'SOL',
      amountRaw: BigInt(received),
      decimals: 9,
      counterparty: payer.toBase58(),
      signature: s.signature,
      createdAt: (s.blockTime ?? Date.now() / 1000) * 1000,
    });
    deposits.push(`+${sol(received)} SOL from ${describeSender(payer.toBase58())}\n${explorerTx(s.signature)}`);
  }

  state.botWallet.lastSignature = signatures[0].signature;
  saveState(state);
  if (deposits.length === 0) return null;

  const balance = await getBotBalance();
  return [
    mode === 'catch-up' ? '💰 While I was offline, the bot wallet received:' : '💰 Bot wallet received:',
    ...deposits,
    '',
    `Bot balance: ${sol(balance)} SOL · ${networkBanner}`,
  ].join('\n');
}
