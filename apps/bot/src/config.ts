import { PublicKey } from '@solana/web3.js';

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseOwnerId(): number | undefined {
  const raw = env('TELEGRAM_OWNER_ID');
  if (!raw) return undefined;
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) throw new Error(`TELEGRAM_OWNER_ID must be a number, got "${raw}"`);
  return id;
}

function parsePhantomAddress(): PublicKey | undefined {
  const raw = env('OWNER_PHANTOM_ADDRESS');
  if (!raw) return undefined;
  try {
    return new PublicKey(raw);
  } catch {
    throw new Error(`OWNER_PHANTOM_ADDRESS is not a valid Solana address: "${raw}"`);
  }
}

const telegramToken = env('TELEGRAM_BOT_TOKEN');
if (!telegramToken) throw new Error('TELEGRAM_BOT_TOKEN is missing. Copy .env.example to .env and fill it in.');

function parseNetwork(): 'devnet' | 'mainnet' {
  const network = env('BOT_WALLET_NETWORK') ?? 'devnet';
  if (network !== 'devnet' && network !== 'mainnet') {
    throw new Error(`BOT_WALLET_NETWORK must be "devnet" or "mainnet", got "${network}"`);
  }
  return network;
}

const rpcUrl = env('SOLANA_RPC_URL') ?? 'https://api.mainnet-beta.solana.com';
const network = parseNetwork();

export const config = {
  telegramToken,
  ownerId: parseOwnerId(),
  phantomAddress: parsePhantomAddress(),
  rpcUrl, // mainnet, for watching your Phantom wallet
  stateFile: env('STATE_FILE') ?? 'data/state.json',
  dbFile: env('DB_FILE') ?? 'data/buttonwood.db',
  heartbeatMs: 30_000,
  walletCheckMs: 60_000,
  engineMs: 60_000,
  whaleMs: 20_000,
  botWallet: {
    network,
    rpcUrl: env('BOT_WALLET_RPC_URL') ?? (network === 'devnet' ? 'https://api.devnet.solana.com' : rpcUrl),
    file: env('BOT_WALLET_FILE') ?? 'data/bot-wallet.enc.json',
    passphrase: env('BOT_KEY_PASSPHRASE'),
  },
};
