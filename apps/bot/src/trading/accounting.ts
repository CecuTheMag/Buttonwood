// Pure position accounting (average cost). No I/O.
import type { Position } from './types.ts';

export type Fill = { side: 'buy' | 'sell'; tokenRaw: bigint; usd: number };

/** Returns the new position and, for sells, the realized profit/loss in USD. */
export function applyFill(position: Position, fill: Fill): { position: Position; realizedPnlUsd: number } {
  if (fill.side === 'buy') {
    return {
      position: { ...position, amountRaw: position.amountRaw + fill.tokenRaw, costUsd: position.costUsd + fill.usd },
      realizedPnlUsd: 0,
    };
  }
  if (fill.tokenRaw > position.amountRaw) throw new Error('cannot sell more than the position');
  // Cost basis leaves in proportion to the amount sold
  const soldCost = position.amountRaw === 0n ? 0 : position.costUsd * (Number(fill.tokenRaw) / Number(position.amountRaw));
  const amountRaw = position.amountRaw - fill.tokenRaw;
  return {
    position: { ...position, amountRaw, costUsd: amountRaw === 0n ? 0 : position.costUsd - soldCost },
    realizedPnlUsd: fill.usd - soldCost,
  };
}
