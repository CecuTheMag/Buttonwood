import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyFill } from '../src/trading/accounting.ts';

const empty = { mint: 'X', amountRaw: 0n, costUsd: 0 };

describe('paper accounting (average cost)', () => {
  it('adds buys to amount and cost', () => {
    let { position } = applyFill(empty, { side: 'buy', tokenRaw: 100n, usd: 100 });
    ({ position } = applyFill(position, { side: 'buy', tokenRaw: 100n, usd: 300 }));
    assert.deepEqual(position, { mint: 'X', amountRaw: 200n, costUsd: 400 }); // avg $2
  });
  it('realizes profit on a partial sell and keeps the average entry', () => {
    const start = { mint: 'X', amountRaw: 200n, costUsd: 400 };
    const { position, realizedPnlUsd } = applyFill(start, { side: 'sell', tokenRaw: 50n, usd: 150 });
    assert.equal(realizedPnlUsd, 50); // sold 50 @ $3, cost was 50 @ $2
    assert.deepEqual(position, { mint: 'X', amountRaw: 150n, costUsd: 300 });
  });
  it('clears cost basis on a full exit and records the loss', () => {
    const { position, realizedPnlUsd } = applyFill({ mint: 'X', amountRaw: 100n, costUsd: 100 }, { side: 'sell', tokenRaw: 100n, usd: 80 });
    assert.equal(realizedPnlUsd, -20);
    assert.deepEqual(position, { mint: 'X', amountRaw: 0n, costUsd: 0 });
  });
  it('refuses to sell more than you hold', () => {
    assert.throws(() => applyFill({ mint: 'X', amountRaw: 10n, costUsd: 10 }, { side: 'sell', tokenRaw: 11n, usd: 1 }));
  });
});
