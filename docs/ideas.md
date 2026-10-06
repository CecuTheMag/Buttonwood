# Ideas

Feature ideas for Buttonwood, grouped by how hard they are. ⭐ = recommended for the first version.

---

## 🟢 MVP: the core

| Idea | Description |
|------|-------------|
| ⭐ **`/balance`** | SOL and token balances with USD values for both the Phantom wallet and the bot wallet |
| ⭐ **`/fund` and `/withdraw`** | QR code to fund from Phantom; one-tap withdraw-all back to Phantom |
| ⭐ **Paper trading mode** | Default mode. A big banner shows PAPER vs LIVE so you never confuse them |
| ⭐ **DCA strategy** | "Buy $5 of SOL every day" |
| ⭐ **Take-profit / stop-loss** | Attach to any position |
| ⭐ **Kill switch** | One button halts everything |
| ⭐ **Trade history** | Table with time, pair, amounts, reason, and a Solscan link |
| ⭐ **Trade notifications** | "Bought 0.12 SOL @ $148.20 (DCA)". Daily summary at 9pm |

## 🟡 Companion features: what makes it more than a bot

| Idea | Description |
|------|-------------|
| **AI companion chat** | Ask "Why did you sell JUP?", "How am I doing this week?", or "Explain what a grid strategy is." Claude reads your trade log and positions (read-only) and answers in plain English. |
| **Trade explanations** | Every trade stores a `reason` string. The AI expands it into a short story: "RSI dropped to 28 and price touched your lower grid line, so the bot bought…" |
| **Daily / weekly digest** | A short AI-written summary: PnL, best and worst trades, what the strategies did, anything unusual |
| **Strategy builder in plain English** | "Buy SOL when it drops 5% in a day, sell half when it's up 10%." The AI converts this into a strategy config, shows you the rules, and backtests them before you enable anything. |
| **Approval buttons** | Trades above your threshold arrive as a message with ✅ Approve / ❌ Reject buttons |
| **Trade journal** | Add your own notes and tags to trades; see patterns over time |
| **Learn mode** | `/learn slippage`: short lessons; failed trades come with a plain-English explanation |
| **Health checks** | "Your bot wallet only has 0.01 SOL for fees", "RPC slow", "Price feeds disagree" |

## 🟠 Intermediate

| Idea | Description |
|------|-------------|
| **Backtester UI** | Pick a strategy and date range, then see an equity curve vs "just hold" |
| **Grid trading** | Visual grid editor drawn on the price chart |
| **Portfolio rebalancer** | Target percentages (e.g. 60% SOL / 30% USDC / 10% JUP) with drift threshold |
| **Token safety score** | Before allowlisting a token: liquidity, holder concentration, mint/freeze authority, RugCheck result |
| **Price alerts** | Notifications without trading ("SOL below $120") |
| **Profit sweep** | Auto-send profits above a target back to Phantom every week |
| **Tax export** | CSV in a format tax tools accept (Koinly, CoinTracker, etc.) |
| **Multiple bot wallets** | One per strategy, so each strategy's PnL is isolated |
| **Use Jupiter's on-chain orders** | DCA and limit orders that keep running even if your server is down |
| **Telegram Mini App** | A full web UI inside Telegram: charts, backtester, strategy editor |
| **Voice messages** | Send a Telegram voice note ("buy 10 dollars of SOL"); transcribe it and ask for confirmation |
| **Pinned live status** | A pinned message the bot keeps editing with live balance and PnL |

## 🔴 Advanced / ambitious

| Idea | Description |
|------|-------------|
| **Copy trading (watch-only first)** | Follow a public wallet you choose; get alerts when it trades; optionally mirror small, capped copies |
| **Sentiment signals** | Combine price data with news/social sentiment (AI-summarized) as an *input* to strategies |
| **Strategy marketplace (personal)** | Save, version, and A/B test your own strategies against each other in paper mode |
| **Multi-chain** | Phantom also supports Ethereum, Base, and others. Add EVM swaps through an aggregator such as 0x or 1inch |
| **Liquidity providing** | Earn fees by providing liquidity on Orca/Meteora (much more complex risk) |
| **Hardware-backed bot signer** | Keep the bot key in a KMS/HSM instead of an encrypted file |

## ⚠️ Ideas to avoid (at least at first)

| Idea | Why not |
|------|---------|
| **New-token sniping / memecoin launch bots** | Mostly rugs and honeypots, dominated by professional MEV bots. The most common way bot builders lose money fast |
| **Leverage / perpetuals** | Liquidation can wipe the position in minutes; add only after everything else is solid |
| **High-frequency trading** | Needs specialized infrastructure; fees will eat a hobby bot alive |
| **Managing other people's money** | Legal and regulatory minefield |
| **"Guaranteed profit" anything** | It doesn't exist. If a strategy looks too good in a backtest, look for a bug |

---

## Web dashboard sketch (for a later Mini App)

For what the Telegram chat looks like, see [telegram-bot.md](telegram-bot.md#what-chatting-with-it-looks-like).

```
┌──────────────────────────────────────────────────────────────────┐
│ 🌳 Buttonwood                     [ PAPER MODE ]   [7xKX…9fQe ▾] │
├──────────────────────────────────────────────────────────────────┤
│  Phantom wallet      Bot wallet          Today       All-time    │
│  $1,240.10           $102.55             +$1.80      +$2.55      │
│                      [Fund] [Withdraw]   +1.79%      +2.55%      │
├───────────────────────────────┬──────────────────────────────────┤
│  Strategies                   │  💬 Companion                     │
│  ● DCA SOL $5/day      ON     │  You: why did you sell JUP?       │
│  ● TP/SL on JUP        ON     │  🌳: JUP hit your +12% take-       │
│  ○ Grid SOL/USDC       OFF    │  profit at $0.91, so the bot sold │
│  [+ New strategy]             │  half the position as configured… │
├───────────────────────────────┴──────────────────────────────────┤
│  Recent trades                                                   │
│  10:02  BUY  SOL   5.00 USDC → 0.0337 SOL   DCA       ↗ Solscan  │
│  08:41  SELL JUP   50 JUP → 45.40 USDC      TP +12%   ↗ Solscan  │
├──────────────────────────────────────────────────────────────────┤
│                                              [ 🛑 STOP ALL ]      │
└──────────────────────────────────────────────────────────────────┘
```
