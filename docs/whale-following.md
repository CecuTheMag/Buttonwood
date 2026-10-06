# Whale following

Buttonwood can follow wallets ("whales") and copy their trades into the **paper** account. Each whale is then judged by **your own results from copying it**, not by its past numbers.

> **Read this first.** Most people who copy-trade lose money. By the time a copier sees a trade (seconds to a minute later) the price has often moved, some wallets deliberately sell into their followers, and memecoin wallets mostly trade tokens that go to zero. Buttonwood is built to *measure* whether following a wallet works, and to stop following it when it doesn't.

## How it works

```mermaid
flowchart TB
    P[Poll each whale every 20s] --> T[New transaction]
    T --> D[Read the whale's balance changes<br/>SOL + wrapped SOL + tokens, minus network fee]
    D --> C{Clean swap?}
    C -- no: transfer, LP, messy multi-token --> I[ignore]
    C -- yes --> S{buy or sell}
    S -- buy --> B1{Already holding a copy<br/>from this whale?}
    B1 -- yes --> I2[ignore: whale adding to position]
    B1 -- no --> B2{Seen within 120s?}
    B2 -- no --> R[report only: too late]
    B2 -- yes --> V{Token safety check}
    V -- fail --> R2[report: not copied + why]
    V -- pass --> RM[Risk manager] --> F[Paper buy at a real Jupiter quote]
    S -- sell --> H{Holding a copy?}
    H -- yes --> SELL[Sell the same fraction they sold]
```

**Reading trades.** For each whale transaction Buttonwood computes the wallet's balance changes (native SOL and wrapped SOL combined, the network fee added back, dust under $1 dropped). Only clean one-in/one-out swaps count. Everything else is ignored rather than guessed.

**One copy per token per whale.** Bots and big wallets often buy in many small pieces. Buttonwood copies the *first* buy and treats the rest as the whale adding to its position. (Tested live: a bot made ~20 buys of one token in two minutes; Buttonwood copied it once.)

**Late buys aren't copied.** After downtime, or if polling falls behind, buys older than `maxCopyDelaySec` (default 120s) are reported but not copied. **Sells are always copied**, because getting out is never too late.

## Token safety check

Before copying any buy of a token that isn't on the built-in allowlist:

| Check | Default | Catches |
|---|---|---|
| Liquidity | ≥ $250,000 | thin pools you can't exit |
| Holders | ≥ 500 | brand-new or fake tokens |
| Age (first pool) | ≥ 24h | fresh launches, most rugs |
| Mint authority disabled | required | creator printing more supply |
| Freeze authority disabled | required | creator freezing your tokens (honeypot) |
| Top holders | ≤ 60% | dumps by insiders |
| **Buy-then-sell quote** | loses < 3% | honeypots and pools you can buy into but not out of |

Verdicts are cached for an hour. Change any threshold with `/copy`.

## Protection on copied positions

- **Copy stop-loss** (default −25%): a whale can hold a coin all the way to zero; you don't have to.
- **Risk manager** applies to every copied buy: max trade size, max % of the portfolio in one token, daily loss limit, buys per hour. Sells are never blocked by these.
- **Auto-pause:** after `autoPauseAfterSells` closed copies (default 5), a whale whose copies lost more than `autoPauseLossPct` (default 5%) of what was spent gets paused, and you get a message. Open copied positions are kept and the stop-loss still applies.

## What /whales shows

```
🟢 alpha 99mR…4F3c
   12 buys, 9 sells · win 56% · net +$4.10 (fees incl.) · 3 skipped
   avg 14s behind them, 0.42% worse price
```

**"worse price"** is the real cost of following: the gap between the whale's own fill (after its network fee) and yours. If that number is larger than the whale's typical gain per trade, copying them can't work, however good they are.

## Finding whales

Buttonwood doesn't pick wallets for you. Candidates can come from public top-trader lists (e.g. GMGN, Birdeye, Cielo) or wallets you've watched yourself. Prefer wallets that:

- trade tokens with real liquidity, not only brand-new launches
- hold for minutes to days, not seconds (you can't copy a sniper 15 seconds late)
- make fewer, larger trades

Then let the paper results decide.

## The go-live gate

`/readiness` checks the **paper** record against a fixed bar:

- 14+ days of paper trading
- 30+ trades, 10+ of them closed
- profitable after fees
- beats just holding SOL over the same period
- worst drop from a peak under 15%

The bot messages you once when everything passes. Real-money execution is a separate step that you switch on yourself, starting small.
