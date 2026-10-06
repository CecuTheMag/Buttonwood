import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkOrder, checkPriceDeviation } from '../src/trading/risk.ts';
import { DEFAULT_LIMITS as limits } from '../src/trading/types.ts';

const buy = { side: 'buy' as const, orderUsd: 10, allowed: true, positionUsdAfter: 10 };
const sell = { ...buy, side: 'sell' as const };
const calm = { killSwitch: false, tradesLastHour: 0, portfolioUsd: 1000, dayStartUsd: 1000 };

describe('risk manager', () => {
  it('allows a normal trade', () => assert.deepEqual(checkOrder(buy, calm, limits), { ok: true }));

  it('kill switch blocks everything, including sells', () => {
    assert.equal(checkOrder(buy, { ...calm, killSwitch: true }, limits).ok, false);
    assert.equal(checkOrder(sell, { ...calm, killSwitch: true }, limits).ok, false);
  });
  it('blocks tokens that are not allowlisted', () => {
    assert.equal(checkOrder({ ...buy, allowed: false }, calm, limits).ok, false);
  });
  it('rate-limits buys per hour, but never sells (a stop-loss must always get out)', () => {
    const busy = { ...calm, tradesLastHour: limits.maxTradesPerHour };
    assert.equal(checkOrder(buy, busy, limits).ok, false);
    assert.deepEqual(checkOrder(sell, busy, limits), { ok: true });
  });
  it('caps the size of a buy', () => {
    assert.equal(checkOrder({ ...buy, orderUsd: limits.maxTradeUsd + 1 }, calm, limits).ok, false);
  });
  it('caps concentration in one token', () => {
    assert.equal(checkOrder({ ...buy, positionUsdAfter: 400 }, calm, limits).ok, false);
  });
  it('pauses buys after the daily loss limit, but never blocks sells', () => {
    const down = { ...calm, portfolioUsd: 940 }; // −6% today, limit 5%
    assert.equal(checkOrder(buy, down, limits).ok, false);
    assert.deepEqual(checkOrder(sell, down, limits), { ok: true });
  });
  it('lets a big stop-loss sell through', () => {
    assert.deepEqual(checkOrder({ ...sell, orderUsd: 900, positionUsdAfter: 0 }, calm, limits), { ok: true });
  });
  it('rejects quotes far from the market price', () => {
    assert.deepEqual(checkPriceDeviation(100.5, 100, limits), { ok: true });
    assert.equal(checkPriceDeviation(103, 100, limits).ok, false);
  });
});
