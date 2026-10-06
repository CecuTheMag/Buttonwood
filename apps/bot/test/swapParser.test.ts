import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SOL_MINT, USDC_MINT } from '../src/tokens.ts';
import { classifySwap, walletDeltas, type TxBalances } from '../src/trading/swapParser.ts';

const W = 'Whale1111111111111111111111111111111111111';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const prices = new Map([[SOL_MINT, 100], [USDC_MINT, 1], [BONK, 0.00002]]);
const tb = (mint: string, amount: string, decimals: number, owner = W) => ({ owner, mint, amount, decimals });

function tx(partial: Partial<TxBalances>): TxBalances {
  return { accountKeys: [W, 'Other'], preBalances: [5e9, 0], postBalances: [5e9, 0], preTokenBalances: [], postTokenBalances: [], ...partial };
}

describe('swap parser', () => {
  it('SOL → token is a buy (new token account, fees ignored)', () => {
    const t = tx({
      preBalances: [5_000_000_000, 0], postBalances: [3_997_955_000, 0], // −1 SOL −rent −fee
      postTokenBalances: [tb(BONK, '5000000000', 5)],                   // +50,000 BONK
    });
    const [signal, ...rest] = classifySwap(walletDeltas(t, W), prices);
    assert.equal(rest.length, 0);
    assert.equal(signal.side, 'buy');
    assert.equal(signal.mint, BONK);
    assert.equal(signal.tokenRaw, 5_000_000_000n);
    assert.equal(signal.quoteMint, SOL_MINT);
  });

  it('token → USDC is a sell with the fraction of the holding', () => {
    const t = tx({
      preTokenBalances: [tb(BONK, '10000000000', 5), tb(USDC_MINT, '0', 6)],
      postTokenBalances: [tb(BONK, '2500000000', 5), tb(USDC_MINT, '1500000', 6)],
    });
    const [signal] = classifySwap(walletDeltas(t, W), prices);
    assert.equal(signal.side, 'sell');
    assert.equal(signal.soldFraction, 0.75);
    assert.equal(signal.quoteRaw, 1_500_000n);
  });

  it('wrapped SOL and native SOL are combined (wrap → swap → close)', () => {
    const t = tx({
      preBalances: [3_000_000_000, 0], postBalances: [3_000_000_000 - 5000 + 2_039_280, 0], // wSOL account closed, rent back
      preTokenBalances: [tb(SOL_MINT, '2000000000', 9), tb(USDC_MINT, '0', 6)],
      postTokenBalances: [tb(USDC_MINT, '200000000', 6)],                                     // sold 2 SOL for $200
    });
    const [signal] = classifySwap(walletDeltas(t, W), prices);
    assert.equal(signal.side, 'sell');
    assert.equal(signal.mint, SOL_MINT);
  });

  it('the network fee is not counted as part of the trade', () => {
    const t = tx({
      fee: 2_000_000, // a big priority fee: 0.002 SOL
      preBalances: [5_000_000_000, 0], postBalances: [3_998_000_000, 0], // paid 1 SOL + fee
      postTokenBalances: [tb(BONK, '5000000000', 5)],
    });
    const [signal] = classifySwap(walletDeltas(t, W), prices);
    assert.equal(signal.quoteRaw, 1_000_000_000n);
  });

  it('a plain transfer (no money moving the other way) is not a trade', () => {
    const t = tx({ preTokenBalances: [tb(BONK, '10000000000', 5)], postTokenBalances: [tb(BONK, '0', 5)] });
    assert.deepEqual(classifySwap(walletDeltas(t, W), prices), []);
  });

  it('ignores token accounts owned by someone else', () => {
    const t = tx({ postTokenBalances: [tb(BONK, '5000000000', 5, 'Other')] });
    assert.deepEqual(walletDeltas(t, W), []);
  });

  it('token → token gives a sell and a buy', () => {
    const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
    const t = tx({
      preTokenBalances: [tb(BONK, '10000000000', 5)],
      postTokenBalances: [tb(BONK, '0', 5), tb(JUP, '3000000', 6)],
    });
    const sides = classifySwap(walletDeltas(t, W), new Map([...prices, [JUP, 0.5]])).map((s) => `${s.side}:${s.mint.slice(0, 3)}`);
    assert.deepEqual(sides, ['sell:Dez', 'buy:JUP']);
  });

  it('ignores dust legs from multi-hop routes', () => {
    const t = tx({
      preBalances: [5_000_000_000, 0], postBalances: [4_000_000_000, 0],
      postTokenBalances: [tb(BONK, '5000000000', 5), tb(USDC_MINT, '10', 6)], // 0.00001 USDC leftover
    });
    const signals = classifySwap(walletDeltas(t, W), prices);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].mint, BONK);
  });
});
