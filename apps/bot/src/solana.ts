import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { config } from './config.ts';
import type { Snapshot } from './state.ts';

export const connection = new Connection(config.rpcUrl, 'confirmed');

/** Mainnet now has v1 transactions; asking for less makes the RPC refuse the whole request. */
export const MAX_TX_VERSION = 1;

const TOKEN_PROGRAMS = [
  new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), // SPL Token
  new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'), // Token-2022
];

/** SOL + every non-zero token balance, in human units. */
export async function getHoldings(owner: PublicKey): Promise<Snapshot> {
  const [lamports, ...tokenResults] = await Promise.all([
    connection.getBalance(owner),
    ...TOKEN_PROGRAMS.map((programId) => connection.getParsedTokenAccountsByOwner(owner, { programId })),
  ]);

  const holdings: Snapshot = { SOL: lamports / LAMPORTS_PER_SOL };
  for (const { value } of tokenResults) {
    for (const { account } of value) {
      const info = account.data.parsed.info;
      const amount = Number(info.tokenAmount.uiAmountString);
      if (amount > 0) holdings[info.mint] = (holdings[info.mint] ?? 0) + amount;
    }
  }
  return holdings;
}

/** Transactions newer than `until`, newest first. */
export async function getNewSignatures(owner: PublicKey, until: string | undefined, limit = 25) {
  return connection.getSignaturesForAddress(owner, { until, limit });
}
