# Strategies, backtesting & the tournament

Buttonwood runs several independent ways of trading side by side **in paper**, tests each on past prices before it gets money, and moves capital toward what actually works.

| | How it works | Good in | Bad in |
|---|---|---|---|
| **DCA** (`/dca`) | Buy a fixed $ amount on a schedule | Long uptrends, for patient accumulation | Doesn't try to time anything |
| **TP/SL** (`/tpsl`) | Sell a held token at +X% or −Y% vs average entry | Protecting other strategies' positions | — (it's a guard) |
| **Trend following** | Hold the token while its 24h average is above its 72h average (with a 0.5% band to avoid flip-flopping); cash otherwise | Strong trends, up or down (it sits out downtrends) | Choppy sideways markets |
| **Grid** | ±10% band split into 10 levels: buy a slice each level down, sell one each level up. Stops out and waits if price falls far below the band | Sideways, choppy markets | Strong trends |
| **Rebalancing** | Keep the token at 50% of the sleeve; trade back when it drifts 5 points | Volatile markets with no clear trend | Long one-way moves |
| **Whale following** | See [whale-following.md](whale-following.md) | — | — |
| **Simulated yield** | Idle USDC earns 4%/yr, SOL 6%/yr (as if lent / liquid-staked) | Always | Paper only for now |

Trend and grid are opposites by design: when one struggles, the other usually does fine. That's why the tournament runs several at once.

## Sleeves

Trend, grid and rebalancing each run in a **sleeve**: their own budget, cash, and tokens inside the paper account. This makes every result attributable: you can see exactly what each strategy earned or lost. A sleeve's budget is also its size limit, so a $200 trend sleeve can buy $200 at once even though manual trades are capped at `/limits maxtrade`.

```
/strategy trend SOL 200
/strategy grid JUP 150 levels=8 rangePct=16
/strategy rebalance WIF 100 targetPct=40 driftPct=8
```

## Backtesting

The backtester replays a strategy hour by hour over past prices, using **exactly the same decision code** that trades live. Costs are deliberately pessimistic: 0.3% per trade for slippage and DEX fees, plus $0.02 network fee.

```
/backtest trend SOL 90          # one strategy, one token, last 90 days
/backtest grid JUP 60 levels=8  # with custom settings
/backtest all 90                # every strategy × every tournament token, ranked
npm run backtest -- all 90      # same, from the command line
```

Price history comes from [GeckoTerminal](https://www.geckoterminal.com) (free, no key): hourly closes from the most liquid **established** pool paired with SOL/USDC/USDT. Pools under 30 days old are ignored, because scam pools report fake liquidity. The live bot then records its own prices every minute, so history stays current.

> **A backtest can only rule ideas out.** A strategy that lost money on the last 90 days is unlikely to make money on the next 90. A strategy that made money in the past might still not; markets change. That's why backtests only earn a place in the tournament and live results decide after that.

## The tournament

On by default. Works without you:

1. **Seed:** when no strategies are running, it backtests every strategy on SOL, JUP, WIF, BONK, JTO and RAY over 90 days, keeps the ones that made money after costs, and enters the best (at most one per token, 4 in total) with budgets from **60% of the paper account**. The rest stays available for DCA, whale copies and manual trades.
2. **Weekly rebalance:** each strategy is scored on its live paper return, minus half its worst drop. For the first week this is blended with a fresh 30-day backtest. Capital is re-split:
   - better scores get more, within a **5% floor and 40% cap** per strategy, so one lucky streak can't take everything
   - strategies down more than 10%, or with a drop over 25%, are **benched**: their position is sold and they stop trading
3. If nothing passes, it tells you so and tries again a week later, rather than trading something it has no reason to believe in.

```
/tournament              # standings
/tournament seed         # pick a lineup now
/tournament rebalance    # re-split capital now
/tournament pool 60      # % of the account it manages
/tournament off          # stop managing (strategies keep running)
```
