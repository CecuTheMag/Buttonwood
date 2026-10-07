# Roadmap

A step-by-step plan for building Buttonwood from zero knowledge. Each phase ends with something that works, and each one teaches you what the next phase needs.

**Golden path:** read-only → paper → tiny live → real live. Never skip ahead.

## Status

| Phase | | |
|---|---|---|
| 0. Basics | ✅ done | |
| 1. Read-only Telegram bot | ✅ done | Phantom watching, offline catch-up |
| 2. Bot wallet | ✅ done | devnet; `/fund`, `/withdraw`, deposit alerts |
| 3. Paper trading | ✅ done | DCA, TP/SL, risk manager, fees, `/performance` |
| 3½. Whale following | ✅ done | copy trading in paper, token safety, auto-pause, **autopilot discovery** ([guide](whale-following.md)) |
| 3¾. Strategy lab | ✅ done | backtester, trend/grid/rebalance, tournament, simulated yield ([guide](strategies.md)) |
| 4. Tiny live trading | ⏳ next | only after `/readiness` passes |
| 5. AI companion | planned | |

---

## Phase 0: Learn the basics (≈ 1 week)

**Goal:** be comfortable with the tools before writing the app.

- [ ] Install Node.js (LTS), VS Code, and git
- [ ] Do a short TypeScript basics tutorial
- [ ] Install Phantom and create a **separate dev wallet** (not your main one). Switch it to devnet in Phantom's developer settings
- [ ] Get free devnet SOL from <https://faucet.solana.com>
- [ ] Read [concepts.md](concepts.md)
- [ ] Create a free Helius or QuickNode account for an RPC URL
- [ ] Write a 10-line script that prints the balance of your Phantom address with `@solana/web3.js`

✅ **Done when:** your script prints your devnet balance.

## Phase 1: Read-only Telegram bot (≈ 1 week)

**Goal:** a Telegram bot that answers only you and shows your Phantom portfolio. No trading, no risk.

- [ ] Create the bot with @BotFather and get your user ID (see [telegram-bot.md](telegram-bot.md#setup-5-minutes))
- [ ] `apps/bot` with grammY: `/start` and the owner-only guard
- [ ] `/balance` shows SOL and token balances (`getParsedTokenAccountsByOwner`) of `OWNER_PHANTOM_ADDRESS`
- [ ] Fetch USD prices and show total portfolio value
- [ ] Check that a friend messaging the bot gets **no** reply

✅ **Done when:** `/balance` on your phone shows your Phantom portfolio in USD.

## Phase 2: Bot wallet on devnet (≈ 1 week)

**Goal:** money moves safely between Phantom and the bot, on devnet.

- [ ] Script that creates and encrypts the bot wallet (see [security](security-and-risk.md#generating-and-storing-the-bot-key))
- [ ] Load the key at startup; `/balance` now shows the bot wallet too
- [ ] `/fund` with QR code (Phantom → bot) and a "💰 Received" notification
- [ ] `/withdraw` with a confirm button (bot → `OWNER_PHANTOM_ADDRESS` only)
- [ ] SQLite database with a `transfers` table

✅ **Done when:** you can fund the bot from Phantom on devnet and `/withdraw` it back.

## Phase 3: Paper trading (≈ 2–3 weeks)

**Goal:** the full trading pipeline running on real prices with fake money.

- [ ] Price feed module (Jupiter Price API)
- [ ] Jupiter quote integration (mainnet quotes, no sending)
- [ ] Strategy interface + **DCA** + **TP/SL**
- [ ] Risk manager with all limits and the kill switch
- [ ] Paper executor, `trades` table, and `/history`
- [ ] `/dca`, `/tpsl`, `/strategies`, `/stop`, `/resume`
- [ ] Trade notifications in Telegram
- [ ] Unit tests for the risk manager and strategies

✅ **Done when:** the bot paper-trades for **2+ weeks** without crashes, and you understand every trade it made.

## Phase 4: Tiny live trading (≈ 1–2 weeks)

**Goal:** prove real execution works, with an amount you don't care about losing.

- [ ] Live executor (sign + send + confirm)
- [ ] Reconcile actual on-chain amounts after each trade
- [ ] Handle failures: expired blockhash, slippage exceeded, RPC timeouts (without double-sending)
- [ ] On startup, sync positions from on-chain balances
- [ ] Fund the bot with a **tiny** amount on mainnet and turn on DCA only

✅ **Done when:** a week of live DCA trades all match between your database and Solscan.

## Phase 5: The companion (≈ 2–3 weeks)

**Goal:** make it feel like a companion, not just a bot.

- [ ] AI chat (Claude API): any non-command message in Telegram, with read-only tools `get_positions`, `get_trades`, `get_pnl`, `explain_trade`
- [ ] Daily digest message
- [ ] ✅/❌ approval buttons for trades above a threshold
- [ ] `/learn <topic>` mini-lessons

✅ **Done when:** you can ask "how did I do this week and why?" and get a correct, specific answer.

## Phase 6: Grow it

Pick from [ideas.md](ideas.md): Telegram Mini App with charts, backtester, grid strategy, rebalancer, token safety score, tax export, deploying to a VPS…

---

## Suggested first commits

1. `chore: add .gitignore (node_modules, .env, *.enc.json, *.db)` ← do this first
2. `chore: scaffold apps/bot with grammY`
3. `feat(bot): owner-only guard and /start`
4. `feat(bot): /balance for the Phantom address`
5. `feat(bot): create and load encrypted bot wallet`

## Where to get help

- Solana docs and cookbook: <https://solana.com/docs>
- Solana Stack Exchange: <https://solana.stackexchange.com>
- Phantom developer docs: <https://docs.phantom.com>
- Jupiter developer docs: <https://dev.jup.ag>
- And me. Ask Claude to build any phase with you step by step.
