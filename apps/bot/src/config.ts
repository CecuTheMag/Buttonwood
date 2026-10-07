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

/**
 * Accepts a full RPC URL, or a bare Helius API key (a common mistake: pasting just the key),
 * which is turned into the Helius mainnet URL. Anything else fails with a clear message.
 */
function parseRpcUrl(name: string, fallback: string): string {
  const raw = env(name);
  if (!raw) return fallback;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return `https://mainnet.helius-rpc.com/?api-key=${raw}`;
  }
  if (!/^https?:\/\//.test(raw)) {
    throw new Error(`${name} must be a URL starting with https:// (e.g. https://mainnet.helius-rpc.com/?api-key=YOUR-KEY)`);
  }
  return raw;
}

const rpcUrl = parseRpcUrl('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com');
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
  whaleMs: 30_000, // ~430k RPC calls/month for 5 whales: fits Helius's free tier with discovery
  botWallet: {
    network,
    rpcUrl: parseRpcUrl('BOT_WALLET_RPC_URL', network === 'devnet' ? 'https://api.devnet.solana.com' : rpcUrl),
    file: env('BOT_WALLET_FILE') ?? 'data/bot-wallet.enc.json',
    passphrase: env('BOT_KEY_PASSPHRASE'),
  },
};
