import type { Snapshot } from './state.ts';
import { symbolFor } from './tokens.ts';

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'less than a minute';
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ');
}

export function formatAmount(n: number): string {
  if (n === 0) return '0';
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return n.toLocaleString('en-US', { maximumSignificantDigits: 6 });
}

export const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function formatPortfolio(holdings: Snapshot, prices: Record<string, number>): string {
  const rows = Object.entries(holdings).map(([asset, amount]) => ({
    asset,
    amount,
    value: prices[asset] != null ? amount * prices[asset] : undefined,
  }));
  // Most valuable first; unpriced tokens (often spam airdrops) last
  rows.sort((a, b) => (b.value ?? -1) - (a.value ?? -1));

  const total = rows.reduce((sum, r) => sum + (r.value ?? 0), 0);
  const lines = rows.slice(0, 15).map((r) =>
    `• ${formatAmount(r.amount)} ${symbolFor(r.asset)}${r.value != null ? `  ${usd(r.value)}` : ''}`,
  );
  if (rows.length > 15) lines.push(`…and ${rows.length - 15} more tokens`);
  const unpriced = rows.filter((r) => r.value == null).length;

  return [
    `Total: ${usd(total)}${unpriced ? ` (+${unpriced} unpriced)` : ''}`,
    '',
    ...lines,
  ].join('\n');
}

/** Lines like "+0.5 SOL" / "−120 JUP" for everything that changed between two snapshots. */
export function formatChanges(before: Snapshot, after: Snapshot): string[] {
  const assets = new Set([...Object.keys(before), ...Object.keys(after)]);
  const lines: string[] = [];
  for (const asset of assets) {
    const diff = (after[asset] ?? 0) - (before[asset] ?? 0);
    if (Math.abs(diff) < 1e-9) continue;
    lines.push(`${diff > 0 ? '+' : '−'}${formatAmount(Math.abs(diff))} ${symbolFor(asset)}`);
  }
  return lines;
}
