import { db } from '../db.ts';
import { USDC_MINT, registerToken } from '../tokens.ts';
import { DEFAULT_LIMITS, type Limits, type Position, type StrategyRow } from './types.ts';

export const DEFAULT_PAPER_USD = 1000;
/** Estimated network + priority fee per swap, charged to paper trades so results aren't flattering. */
export const PAPER_FEE_USD = 0.02;

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS strategies (
    id         INTEGER PRIMARY KEY,
    type       TEXT    NOT NULL,
    params     TEXT    NOT NULL,             -- JSON
    enabled    INTEGER NOT NULL DEFAULT 1,
    state      TEXT    NOT NULL DEFAULT '{}', -- JSON, e.g. DCA lastRunAt (survives restarts)
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trades (
    id           INTEGER PRIMARY KEY,
    mode         TEXT    NOT NULL,           -- 'paper' | 'live'
    strategy_id  INTEGER,                    -- null = manual
    side         TEXT    NOT NULL,
    mint         TEXT    NOT NULL,
    token_raw    TEXT    NOT NULL,
    usd          REAL    NOT NULL,
    price        REAL    NOT NULL,           -- fill price per token
    ref_price    REAL    NOT NULL,           -- market price when decided
    realized_pnl REAL    NOT NULL DEFAULT 0,
    reason       TEXT    NOT NULL,
    signature    TEXT,                       -- null for paper trades
    created_at   INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS paper_positions (
    mint       TEXT PRIMARY KEY,             -- USDC row = paper cash
    amount_raw TEXT NOT NULL,
    cost_usd   REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS equity (          -- portfolio value over time: drawdown, daily returns
    ts        INTEGER PRIMARY KEY,
    value_usd REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tokens (          -- tokens learned from whale trades + their safety verdict
    mint       TEXT PRIMARY KEY,
    symbol     TEXT NOT NULL,
    decimals   INTEGER NOT NULL,
    safe       INTEGER NOT NULL,
    reason     TEXT NOT NULL,
    checked_at INTEGER NOT NULL
  );
`);

// Migrations for databases created by earlier versions
function addColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('trades', 'whale', 'TEXT');
addColumn('trades', 'fee_usd', 'REAL NOT NULL DEFAULT 0');

// Make learned tokens known to the rest of the bot
for (const row of db.prepare('SELECT mint, symbol, decimals FROM tokens').all() as { mint: string; symbol: string; decimals: number }[]) {
  registerToken(row);
}

/** Run several writes atomically. */
export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ── settings ────────────────────────────────────────────────────────────────
export function getSetting<T>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}
export function setSetting(key: string, value: unknown) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export const getLimits = (): Limits => ({ ...DEFAULT_LIMITS, ...getSetting<Partial<Limits>>('limits', {}) });
export const setLimit = (key: keyof Limits, value: number) => setSetting('limits', { ...getSetting('limits', {}), [key]: value });

/** Persisted: a /stop survives restarts. */
export const isStopped = () => getSetting('kill_switch', false);
export const setStopped = (on: boolean) => setSetting('kill_switch', on);

// ── strategies ──────────────────────────────────────────────────────────────
export function listStrategies(): StrategyRow[] {
  const rows = db.prepare('SELECT * FROM strategies ORDER BY id').all() as Record<string, any>[];
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    params: JSON.parse(r.params),
    enabled: r.enabled === 1,
    state: JSON.parse(r.state),
  })) as StrategyRow[];
}
export function addStrategy(type: StrategyRow['type'], params: StrategyRow['params']): number {
  const result = db.prepare('INSERT INTO strategies (type, params, created_at) VALUES (?, ?, ?)')
    .run(type, JSON.stringify(params), Date.now());
  return Number(result.lastInsertRowid);
}
export const setStrategyEnabled = (id: number, enabled: boolean) =>
  db.prepare('UPDATE strategies SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id).changes > 0;
export const deleteStrategy = (id: number) => db.prepare('DELETE FROM strategies WHERE id = ?').run(id).changes > 0;
export const saveStrategyState = (id: number, state: object) =>
  db.prepare('UPDATE strategies SET state = ? WHERE id = ?').run(JSON.stringify(state), id);

// ── paper account ───────────────────────────────────────────────────────────
export function getPositions(): Map<string, Position> {
  const rows = db.prepare('SELECT * FROM paper_positions').all() as Record<string, any>[];
  return new Map(rows.map((r) => [r.mint, { mint: r.mint, amountRaw: BigInt(r.amount_raw), costUsd: r.cost_usd }]));
}
export function savePosition(p: Position) {
  db.prepare(
    `INSERT INTO paper_positions (mint, amount_raw, cost_usd) VALUES (?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET amount_raw = excluded.amount_raw, cost_usd = excluded.cost_usd`,
  ).run(p.mint, p.amountRaw.toString(), p.costUsd);
}

/** Wipes paper balances and paper trades and starts again with `usd` of paper USDC. */
export function resetPaper(usd: number) {
  transaction(() => {
    db.exec('DELETE FROM paper_positions');
    db.exec("DELETE FROM trades WHERE mode = 'paper'");
    savePosition({ mint: USDC_MINT, amountRaw: BigInt(Math.round(usd * 1e6)), costUsd: usd });
    setSetting('paper_start_usd', usd);
    db.prepare("DELETE FROM settings WHERE key = 'day_start'").run();
    db.exec("UPDATE strategies SET state = '{}'"); // DCA schedules start fresh
    db.exec('DELETE FROM equity');
    setSetting('paper_start_at', Date.now());
    db.prepare("DELETE FROM settings WHERE key IN ('paper_start_sol_price', 'readiness_notified')").run();
  });
}

/** First run: open the paper account automatically. */
export function ensurePaperAccount() {
  if (getSetting<number | null>('paper_start_usd', null) === null) resetPaper(DEFAULT_PAPER_USD);
  if (getSetting<number | null>('paper_start_at', null) === null) setSetting('paper_start_at', Date.now());
}

// ── trades ──────────────────────────────────────────────────────────────────
export type TradeRecord = {
  mode: 'paper' | 'live';
  strategyId: number | null;
  side: 'buy' | 'sell';
  mint: string;
  tokenRaw: bigint;
  usd: number;
  price: number;
  refPrice: number;
  realizedPnl: number;
  reason: string;
  signature: string | null;
  createdAt: number;
  whale: string | null;
  feeUsd: number;
};

export function recordTrade(t: TradeRecord) {
  db.prepare(
    `INSERT INTO trades (mode, strategy_id, side, mint, token_raw, usd, price, ref_price, realized_pnl, reason, signature, created_at, whale, fee_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(t.mode, t.strategyId, t.side, t.mint, t.tokenRaw.toString(), t.usd, t.price, t.refPrice, t.realizedPnl, t.reason, t.signature, t.createdAt, t.whale, t.feeUsd);
}

export function recentTrades(limit = 10): TradeRecord[] {
  const rows = db.prepare('SELECT * FROM trades ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, any>[];
  return rows.map((r) => ({
    mode: r.mode, strategyId: r.strategy_id, side: r.side, mint: r.mint, tokenRaw: BigInt(r.token_raw),
    usd: r.usd, price: r.price, refPrice: r.ref_price, realizedPnl: r.realized_pnl, reason: r.reason,
    signature: r.signature, createdAt: r.created_at, whale: r.whale, feeUsd: r.fee_usd,
  }));
}

export function tradesBetween(fromMs: number, toMs: number): TradeRecord[] {
  return recentTradesWhere('created_at >= ? AND created_at < ?', fromMs, toMs);
}

function recentTradesWhere(where: string, ...params: (number | string)[]): TradeRecord[] {
  const rows = db.prepare(`SELECT * FROM trades WHERE ${where} ORDER BY created_at`).all(...params) as Record<string, any>[];
  return rows.map((r) => ({
    mode: r.mode, strategyId: r.strategy_id, side: r.side, mint: r.mint, tokenRaw: BigInt(r.token_raw),
    usd: r.usd, price: r.price, refPrice: r.ref_price, realizedPnl: r.realized_pnl, reason: r.reason,
    signature: r.signature, createdAt: r.created_at, whale: r.whale, feeUsd: r.fee_usd,
  }));
}

export const allTrades = () => recentTradesWhere("mode = 'paper'");

// ── equity snapshots ────────────────────────────────────────────────────────
export function snapshotEquity(valueUsd: number, everyMs = 3_600_000) {
  const last = db.prepare('SELECT MAX(ts) AS ts FROM equity').get() as { ts: number | null };
  if (last.ts && Date.now() - last.ts < everyMs) return;
  db.prepare('INSERT OR REPLACE INTO equity (ts, value_usd) VALUES (?, ?)').run(Date.now(), valueUsd);
}
export const equityHistory = () =>
  db.prepare('SELECT ts, value_usd AS valueUsd FROM equity ORDER BY ts').all() as { ts: number; valueUsd: number }[];

// ── learned tokens ──────────────────────────────────────────────────────────
export type TokenVerdict = { mint: string; symbol: string; decimals: number; safe: boolean; reason: string; checkedAt: number };
export function getTokenVerdict(mint: string): TokenVerdict | undefined {
  const r = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(mint) as Record<string, any> | undefined;
  return r && { mint: r.mint, symbol: r.symbol, decimals: r.decimals, safe: r.safe === 1, reason: r.reason, checkedAt: r.checked_at };
}
export function saveTokenVerdict(v: TokenVerdict) {
  db.prepare(
    `INSERT INTO tokens (mint, symbol, decimals, safe, reason, checked_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET symbol = excluded.symbol, decimals = excluded.decimals, safe = excluded.safe,
       reason = excluded.reason, checked_at = excluded.checked_at`,
  ).run(v.mint, v.symbol, v.decimals, v.safe ? 1 : 0, v.reason, v.checkedAt);
  registerToken({ mint: v.mint, symbol: v.symbol, decimals: v.decimals }, true);
}

export const tradesSince = (ms: number) =>
  (db.prepare('SELECT COUNT(*) AS n FROM trades WHERE created_at >= ?').get(ms) as { n: number }).n;

export const realizedPnlTotal = () =>
  (db.prepare("SELECT COALESCE(SUM(realized_pnl), 0) AS total FROM trades WHERE mode = 'paper'").get() as { total: number }).total;
