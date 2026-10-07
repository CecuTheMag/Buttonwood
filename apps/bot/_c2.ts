import { ensureHistory, getBars } from './src/trading/candles.ts';
import { TRADABLE } from './src/tokens.ts';
for (const sym of ['SOL', 'WIF', 'BONK']) {
  const t = TRADABLE.find((x) => x.symbol === sym)!;
  const started = Date.now();
  await ensureHistory(t.mint, 120);
  const bars = getBars(t.mint, 24 * 120);
  const gaps = bars.slice(1).filter((b, i) => b.ts - bars[i].ts > 3600).length;
  console.log(`${sym}: ${bars.length} bars ${new Date(bars[0].ts * 1000).toISOString().slice(0, 10)} → ${new Date(bars.at(-1)!.ts * 1000).toISOString().slice(0, 16)}, gaps ${gaps}, close ${bars.at(-1)!.close.toPrecision(5)} (${Math.round((Date.now() - started) / 1000)}s)`);
}
