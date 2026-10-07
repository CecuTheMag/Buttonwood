import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scoreWallet, type TradeEvent } from '../src/trading/walletScore.ts';

const H = 3600;
const liquid = () => true;
/** A profitable round trip in `mint`: buy at t, sell 1.2x at t + hold. */
const roundTrip = (mint: string, t: number, holdSec: number, gain = 1.2): TradeEvent[] => [
  { time: t, side: 'buy', mint, tokenAmount: 100, usd: 100 },
  { time: t + holdSec, side: 'sell', mint, tokenAmount: 100, usd: 100 * gain },
];

describe('wallet scoring', () => {
  it('a patient, profitable trader is eligible', () => {
    const events = Array.from({ length: 6 }, (_, i) => roundTrip(`M${i}`, i * 10 * H, 2 * H)).flat();
    const s = scoreWallet(events, liquid);
    assert.equal(s.closed, 6);
    assert.equal(s.winRate, 1);
    assert.equal(Math.round(s.roiPct), 20);
    assert.equal(s.medianHoldMin, 120);
    assert.ok(s.eligible, s.reasons.join());
    assert.ok(s.score > 0);
  });

  it('too few round trips cannot be judged', () => {
    const s = scoreWallet(roundTrip('A', 0, H), liquid);
    assert.equal(s.eligible, false);
    assert.match(s.reasons[0], /only 1 closed/);
  });

  it('a sniper that flips in seconds is rejected as uncopyable', () => {
    const events = Array.from({ length: 6 }, (_, i) => roundTrip(`M${i}`, i * H, 20)).flat();
    assert.ok(scoreWallet(events, liquid).reasons.some((r) => r.includes('too fast to copy')));
  });

  it('losers are rejected', () => {
    const events = Array.from({ length: 6 }, (_, i) => roundTrip(`M${i}`, i * 10 * H, 2 * H, 0.9)).flat();
    const s = scoreWallet(events, liquid);
    assert.equal(s.winRate, 0);
    assert.ok(s.realizedUsd < 0);
    assert.equal(s.eligible, false);
  });

  it('hyperactive wallets are rejected as bot-like', () => {
    const events = Array.from({ length: 50 }, (_, i) => roundTrip(`M${i % 5}`, i * 60, 30 * 60)).flat()
      .sort((a, b) => a.time - b.time);
    assert.ok(scoreWallet(events, liquid).reasons.some((r) => r.includes('bot-like')));
  });

  it('wallets trading only illiquid tokens are rejected', () => {
    const events = Array.from({ length: 6 }, (_, i) => roundTrip(`M${i}`, i * 10 * H, 2 * H)).flat();
    assert.ok(scoreWallet(events, () => false).reasons.some((r) => r.includes('liquid')));
  });

  it('partial sells use average cost; sells without a known buy are skipped', () => {
    const s = scoreWallet([
      { time: 0, side: 'sell', mint: 'X', tokenAmount: 10, usd: 50 }, // bought before the window
      { time: 1, side: 'buy', mint: 'A', tokenAmount: 100, usd: 100 },
      { time: 2, side: 'buy', mint: 'A', tokenAmount: 100, usd: 300 }, // avg $2
      { time: 3, side: 'sell', mint: 'A', tokenAmount: 50, usd: 150 },  // cost $100 → +$50
    ], liquid);
    assert.equal(s.closed, 1);
    assert.equal(s.realizedUsd, 50);
  });
});
