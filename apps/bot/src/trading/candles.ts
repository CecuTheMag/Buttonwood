// Hourly price history: backfilled from GeckoTerminal (free, no key), kept current from live prices.
import { db } from '../db.ts';
import { BASE_MINTS } from '../tokens.ts';
import type { Bar } from './sleeve.ts';
import { getSetting, setSetting } from './store.ts';

const GECKO = 'https://api.geckoterminal.com/api/v2/networks/solana';
const HOUR = 3600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

db.exec(`
  CREATE TABLE IF NOT EXISTS candles (
    mint  TEXT    NOT NULL,
    ts    INTEGER NOT NULL,  -- hour start, seconds
    close REAL    NOT NULL,
    PRIMARY KEY (mint, ts)
  );
`);

/** Called every engine tick: the last price seen in an hour becomes that hour's close. */
export function recordPrice(mint: string, price: number, nowMs = Date.now()) {
  const hour = Math.floor(nowMs / 1000 / HOUR) * HOUR;
  db.prepare('INSERT INTO candles (mint, ts, close) VALUES (?, ?, ?) ON CONFLICT(mint, ts) DO UPDATE SET close = excluded.close')
    .run(mint, hour, price);
}

/** Completed hourly bars (the current, unfinished hour is excluded), oldest first. */
export function getBars(mint: string, hours: number, nowMs = Date.now()): Bar[] {
  const currentHour = Math.floor(nowMs / 1000 / HOUR) * HOUR;
  const rows = db.prepare('SELECT ts, close FROM candles WHERE mint = ? AND ts < ? ORDER BY ts DESC LIMIT ?')
    .all(mint, currentHour, hours) as Bar[];
  return rows.reverse();
}

export const barCount = (mint: string) => (db.prepare('SELECT COUNT(*) AS n FROM candles WHERE mint = ?').get(mint) as { n: number }).n;

// GeckoTerminal's free tier allows ~30 requests/minute
let lastGecko = 0;
async function gecko(path: string): Promise<any> {
  const wait = lastGecko + 6000 - Date.now(); // the free tier is stricter in practice than its documented 30/min
  if (wait > 0) await sleep(wait);
  lastGecko = Date.now();
  const res = await fetch(`${GECKO}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 429) {
    await sleep(30_000);
    return gecko(path);
  }
  if (!res.ok) throw new Error(`GeckoTerminal ${res.status} for ${path.split('?')[0]}`);
  return res.json();
}

type GeckoPool = {
  attributes: { address: string; reserve_in_usd: string; pool_created_at: string };
  relationships: { base_token: { data: { id: string } }; quote_token: { data: { id: string } } };
};

/**
 * The pool to read prices from, cached for a week. "Biggest pool" alone is unsafe: scam pools
 * report huge fake reserves (seen in testing: a day-old pool claiming $184M). So: only pools
 * 30+ days old, paired against SOL/USDC/USDT, then the biggest of those.
 */
async function topPool(mint: string): Promise<string> {
  const cached = getSetting<{ pool: string; at: number } | null>(`gecko_pool2_${mint}`, null);
  if (cached && Date.now() - cached.at < 7 * 86_400_000) return cached.pool;
  const data = await gecko(`/tokens/${mint}/pools?page=1`);
  const pools = (data.data ?? []) as GeckoPool[];
  if (pools.length === 0) throw new Error('no pools found');
  const other = (p: GeckoPool) => {
    const ids = [p.relationships.base_token.data.id, p.relationships.quote_token.data.id].map((id) => id.replace(/^solana_/, ''));
    return ids.find((id) => id !== mint) ?? '';
  };
  const ageDays = (p: GeckoPool) => (Date.now() - Date.parse(p.attributes.pool_created_at)) / 86_400_000;
  const trusted = pools.filter((p) => ageDays(p) >= 30 && BASE_MINTS.has(other(p)));
  const pick = (trusted.length ? trusted : [...pools].sort((a, b) => ageDays(b) - ageDays(a)).slice(0, 1))
    .sort((a, b) => Number(b.attributes.reserve_in_usd) - Number(a.attributes.reserve_in_usd))[0].attributes.address;
  setSetting(`gecko_pool2_${mint}`, { pool: pick, at: Date.now() });
  return pick;
}

/**
 * Makes sure we have `days` of hourly history for a token. Fetches only what's missing
 * (older history, plus any gap since the newest bar), so it's cheap to call often.
 */
export async function ensureHistory(mint: string, days: number): Promise<number> {
  const wantFrom = Math.floor(Date.now() / 1000) - days * 86_400;
  const range = db.prepare('SELECT MIN(ts) AS first, MAX(ts) AS last FROM candles WHERE mint = ?').get(mint) as { first: number | null; last: number | null };
  const missingOld = range.first === null || range.first > wantFrom + 2 * HOUR;
  const gapRecent = range.last === null || Date.now() / 1000 - range.last > 3 * HOUR;
  if (!missingOld && !gapRecent) return barCount(mint);

  const pool = await topPool(mint);
  const insert = db.prepare('INSERT OR IGNORE INTO candles (mint, ts, close) VALUES (?, ?, ?)');
  let before = Math.floor(Date.now() / 1000);
  for (let page = 0; page < 8 && before > wantFrom; page++) {
    const data = await gecko(`/pools/${pool}/ohlcv/hour?aggregate=1&limit=1000&currency=usd&token=${mint}&before_timestamp=${before}`);
    const list = (data.data?.attributes?.ohlcv_list ?? []) as number[][];
    if (list.length === 0) break;
    db.exec('BEGIN');
    try {
      for (const [ts, , , , close] of list) if (close > 0) insert.run(mint, ts, close);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    before = Math.min(...list.map((c) => c[0]));
    // Already had everything older than this page? Then only the recent gap was missing.
    if (!missingOld && range.last !== null && before <= range.last) break;
  }
  return barCount(mint);
}

export function pruneCandles(keepDays = 365) {
  db.prepare('DELETE FROM candles WHERE ts < ?').run(Math.floor(Date.now() / 1000) - keepDays * 86_400);
}
