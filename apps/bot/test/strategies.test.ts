import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SOL_MINT } from '../src/tokens.ts';
import { changeVsEntry, dcaDue, runDca, runTpsl } from '../src/trading/strategies.ts';

const HOUR = 3_600_000;
const now = 1_800_000_000_000;

describe('DCA', () => {
  it('buys on the very first run', () => {
    assert.deepEqual(dcaDue(undefined, 24, now), { due: true, missed: 0 });
  });
  it('waits until the interval has passed', () => {
    assert.equal(dcaDue(now - 23 * HOUR, 24, now).due, false);
    assert.deepEqual(dcaDue(now - 24 * HOUR, 24, now), { due: true, missed: 0 });
  });
  it('after downtime buys ONCE and reports the skipped runs', () => {
    assert.deepEqual(dcaDue(now - 75 * HOUR, 24, now), { due: true, missed: 2 });
    const order = runDca(1, { mint: SOL_MINT, usd: 5, everyHours: 24 }, now - 75 * HOUR, now)!;
    assert.equal(order.side, 'buy');
    assert.equal(order.amount, 5);
    assert.match(order.reason, /2 scheduled buy\(s\) missed/);
  });
  it('ignores tokens that are not on the allowlist', () => {
    assert.equal(runDca(1, { mint: 'NotARealMint', usd: 5, everyHours: 1 }, undefined, now), null);
  });
});

describe('TP/SL', () => {
  // 2 SOL bought for $200 → average entry $100
  const position = { mint: SOL_MINT, amountRaw: 2_000_000_000n, costUsd: 200 };
  const params = { mint: SOL_MINT, takeProfitPct: 15, stopLossPct: 8 };

  it('measures change vs average entry', () => {
    assert.equal(changeVsEntry(position, 9, 110)!.toFixed(2), '10.00');
  });
  it('does nothing inside the band', () => {
    assert.equal(runTpsl(1, params, position, 110), null);
    assert.equal(runTpsl(1, params, position, 93), null);
  });
  it('takes profit at the target', () => {
    const order = runTpsl(1, params, position, 115)!;
    assert.equal(order.side, 'sell');
    assert.equal(order.amount, 1);
    assert.match(order.reason, /Take-profit/);
  });
  it('stops the loss at the limit', () => {
    assert.match(runTpsl(1, params, position, 92)!.reason, /Stop-loss/);
  });
  it('a 0 turns that side off', () => {
    assert.equal(runTpsl(1, { ...params, takeProfitPct: 0 }, position, 500), null);
  });
  it('ignores missing positions, missing prices and dust', () => {
    assert.equal(runTpsl(1, params, undefined, 50), null);
    assert.equal(runTpsl(1, params, position, undefined), null);
    assert.equal(runTpsl(1, params, { mint: SOL_MINT, amountRaw: 1000n, costUsd: 1 }, 50), null);
  });
});
