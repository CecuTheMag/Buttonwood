# Concepts for beginners

This page covers everything you need to know before building Buttonwood. No prior crypto knowledge assumed.

---

## Wallets and keys

A **wallet** is really just a **keypair**:

- **Public key (address).** Like a bank account number. Safe to share. Example: `7xKX...9fQe`.
- **Private key / seed phrase.** Like the password *and* the signature on every cheque. Whoever has it controls the funds. **Never share it, never commit it to git, never paste it into a website.**

**Phantom** is wallet *software*. It stores your private key encrypted on your device and shows you a popup whenever an app wants to use it. Apps never see the private key; they only ever get your public key and the signatures you approve.

## Solana

Phantom supports several blockchains, but Buttonwood targets **Solana** because:

- Transactions are cheap (fractions of a cent) and fast (under a second to a few seconds).
- It has deep trading liquidity and excellent tooling for bots.
- Phantom started as a Solana wallet, and its Solana support is the most mature.

Units: **1 SOL = 1,000,000,000 lamports.** Code always works in lamports (integers) to avoid floating-point errors.

**Networks:**

| Network | Use |
|---------|-----|
| `mainnet-beta` | Real money |
| `devnet` | Free fake SOL for testing transfers and code (no real DEX liquidity) |
| `localnet` | A chain on your own computer |

## Tokens

Every token on Solana is identified by its **mint address**, not its name. Anyone can create a token called "USDC", but only one mint is the real one:

| Token | Mint address |
|-------|--------------|
| SOL (wrapped) | `So11111111111111111111111111111111111111112` |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |

> ⚠️ Always identify tokens by mint address. Scam tokens copy names and logos.

Each token also has **decimals** (USDC has 6, SOL has 9). `1 USDC` = `1_000_000` base units.

## Transactions and signing

To do anything on-chain (send, swap) you build a **transaction**, **sign** it with a private key, and **send** it to an **RPC node**, a server that relays it to the network.

- Every transaction costs a small **fee** (about 0.000005 SOL), plus an optional **priority fee** that gets it processed faster when the network is busy.
- A transaction either fully succeeds or fully fails. Failed transactions still cost the fee.

## DEXs, aggregators, and swaps

A **DEX** (decentralized exchange) is a program on the blockchain that holds pools of tokens. You trade against the pool, with no company or order book in the middle. Examples on Solana: Raydium, Orca, Meteora.

An **aggregator** like **Jupiter** checks all DEXs and finds the best route for your trade (sometimes splitting it across several pools). Buttonwood uses Jupiter so it doesn't need to integrate each DEX itself.

A **swap** = "trade token A for token B", for example 0.1 SOL → ~15 USDC.

## Trading terms you'll see in the code

| Term | Meaning |
|------|---------|
| **Slippage** | The price moving between when you get a quote and when your trade lands. You set a max (e.g. 0.5% = `50` bps). If it moves more, the trade fails instead of filling at a bad price. |
| **bps** | Basis points. 1 bps = 0.01%, 100 bps = 1%. |
| **Price impact** | How much *your own* trade moves the price. Big trades in small pools have high impact. |
| **Liquidity** | How much money is in a pool. Low liquidity = high price impact and easy manipulation. |
| **MEV / sandwich attack** | A bot sees your pending trade, buys just before you, and sells just after, profiting off your slippage. Tight slippage limits reduce this. |
| **Rug pull** | Token creators drain the liquidity pool or dump their supply, and the price goes to ~0. |
| **Honeypot** | A token you can buy but can't sell. |
| **DCA** | Dollar-cost averaging: buying a fixed amount on a schedule, regardless of price. |
| **Take-profit / stop-loss** | Auto-sell when the price rises to X (lock in gains) or falls to Y (limit losses). |
| **Backtest** | Running a strategy on historical prices to see how it *would have* done. |
| **Paper trading** | Running the bot on live prices with fake money. |
| **PnL** | Profit and loss. |

## Why Phantom can't "just trade for me"

Phantom is built so that **no app can move your funds without you clicking Approve.** There is no "let this app trade freely" setting, and that's a feature. So an always-on bot needs its own key that it can sign with. That's the reason for the [two-wallet model](phantom-integration.md#the-two-wallet-model).
