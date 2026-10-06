import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

mkdirSync(dirname(config.dbFile), { recursive: true });
export const db = new DatabaseSync(config.dbFile);

db.exec(`
  CREATE TABLE IF NOT EXISTS transfers (
    id           INTEGER PRIMARY KEY,
    direction    TEXT    NOT NULL CHECK (direction IN ('in', 'out')),
    network      TEXT    NOT NULL,
    asset        TEXT    NOT NULL,          -- 'SOL' or token mint
    amount_raw   TEXT    NOT NULL,          -- base units (lamports), as text to keep full precision
    decimals     INTEGER NOT NULL,
    counterparty TEXT    NOT NULL,          -- the other wallet
    signature    TEXT    NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL           -- ms since epoch
  )
`);

export type Transfer = {
  direction: 'in' | 'out';
  network: string;
  asset: string;
  amountRaw: bigint;
  decimals: number;
  counterparty: string;
  signature: string;
  createdAt: number;
};

/** Idempotent: recording the same signature twice is a no-op. */
export function recordTransfer(t: Transfer) {
  db.prepare(
    `INSERT OR IGNORE INTO transfers (direction, network, asset, amount_raw, decimals, counterparty, signature, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(t.direction, t.network, t.asset, t.amountRaw.toString(), t.decimals, t.counterparty, t.signature, t.createdAt);
}

export function recentTransfers(limit = 10): Transfer[] {
  const rows = db
    .prepare('SELECT * FROM transfers ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Record<string, any>[];
  return rows.map((r) => ({
    direction: r.direction,
    network: r.network,
    asset: r.asset,
    amountRaw: BigInt(r.amount_raw),
    decimals: r.decimals,
    counterparty: r.counterparty,
    signature: r.signature,
    createdAt: r.created_at,
  }));
}
