# Security & risk

There are two kinds of danger: **someone steals the money** (security) and **the bot loses the money** (trading risk). Plan for both.

---

## Part 1: Security

### The golden rules

1. **The bot key never touches the browser, git, logs, or chat (including Telegram).** It lives on the server, encrypted.
2. **The bot can only withdraw to your Phantom address.** Hard-coded in config, not accepted from requests.
3. **Fund the bot with small amounts.** Treat the bot wallet like cash in your pocket, not your savings account.
4. **Never ask for, or store, your Phantom seed phrase.** Buttonwood doesn't need it, ever.
5. **`.env` is in `.gitignore` from the very first commit.**

### Generating and storing the bot key

```ts
// scripts/create-bot-wallet.ts: run once
import { Keypair } from '@solana/web3.js';
import { scryptSync, randomBytes, createCipheriv } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const kp = Keypair.generate();
const passphrase = process.env.BOT_KEY_PASSPHRASE!;
const salt = randomBytes(16);
const key = scryptSync(passphrase, salt, 32);
const iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', key, iv);
const encrypted = Buffer.concat([cipher.update(Buffer.from(kp.secretKey)), cipher.final()]);

writeFileSync('bot-wallet.enc.json', JSON.stringify({
  publicKey: kp.publicKey.toBase58(),
  salt: salt.toString('hex'),
  iv: iv.toString('hex'),
  tag: cipher.getAuthTag().toString('hex'),
  data: encrypted.toString('hex'),
}));
console.log('Bot wallet address:', kp.publicKey.toBase58());
```

- Add `bot-wallet.enc.json` to `.gitignore` as well.
- Back up the encrypted file and the passphrase **separately** (for example, a password manager plus an offline copy).
- Later upgrade: use a cloud KMS/secret manager, or a hardware-backed signer.

### Server and app hardening checklist

- [ ] Telegram bot answers **only** `TELEGRAM_OWNER_ID`, and Telegram two-step verification is on (see [telegram-bot.md](telegram-bot.md#security-rules-specific-to-telegram))
- [ ] Bot token is in `.env` only; revoke it in @BotFather if it ever leaks
- [ ] *(If you add a web UI)* Dashboard login = Phantom signed message (see [Phantom integration](phantom-integration.md#step-2-sign-in-with-phantom-prove-its-really-you)), with only `OWNER_PHANTOM_ADDRESS` allowed
- [ ] Nonces are single-use and expire after ~5 minutes
- [ ] Session cookies are `httpOnly`, `secure`, and `sameSite=strict`
- [ ] Withdrawals and live-mode toggles require a **fresh** signature, not just a session
- [ ] Rate-limit the API
- [ ] The VPS uses SSH keys only, has a firewall, and gets auto security updates
- [ ] Logs never print keys, signatures of auth messages, or API keys
- [ ] Dependencies are pinned and you run `npm audit`. Crypto libraries are a favorite **supply-chain attack** target, so be careful with typo-squatted package names.
- [ ] Separate RPC/API keys for dev and prod

### Scams to watch out for while building

- "Support" DMs asking for your seed phrase. Real support never asks.
- Fake npm packages or GitHub repos that promise "free trading bot, just paste your private key".
- Airdropped tokens in your wallet with a link to "claim". Don't click it, and don't let the bot trade them (that's what the allowlist is for).
- Websites that look like Phantom or Jupiter. Bookmark the real ones.

---

## Part 2: Trading risk

### How trading bots actually lose money

| Risk | What happens | Defense |
|------|--------------|---------|
| **Bad strategy** | Works in backtests, loses live (overfitting) | Paper trade for weeks; compare to "just hold" |
| **Fees & slippage** | Many small trades → costs eat all the profit | Fewer, larger trades; track fees in PnL |
| **Sandwich / MEV** | Bots front-run your trades | Tight slippage (≤ 0.5–1%), avoid low-liquidity tokens |
| **Rug pulls / honeypots** | Token goes to zero or can't be sold | Token allowlist; check with RugCheck; minimum liquidity filter |
| **Bugs** | Loop buys 100× instead of 1× | Max trade size, max trades/hour, idempotent order IDs, tests |
| **Stale/wrong prices** | Bot acts on a broken feed | Compare two price sources; circuit breaker |
| **Outages** | RPC down, bot crashes mid-trade | Retries with care (don't double-send), reconcile with on-chain balances on restart |
| **Market crash** | Everything drops 40% overnight | Daily loss limit, stop-losses, only fund what you can lose |

### Recommended starting limits

| Setting | Start with |
|---------|-----------|
| Bot wallet funding | An amount you'd be OK losing entirely |
| Max single trade | ≤ 10% of bot balance |
| Max in one token | ≤ 25% of bot balance |
| Daily loss limit | 5% of bot balance → auto-pause |
| Slippage | 0.5% (50 bps) for majors, 1% max otherwise |
| Tokens | SOL, USDC, and a few large, well-known tokens only |

### Legal and tax

- In most countries **every swap is a taxable event**. Keep full records (Buttonwood's trade log helps); a CSV export for tax tools is in the [ideas list](ideas.md).
- If you ever let *other people* use Buttonwood with their money, you're likely entering regulated territory (custody, investment services). Keep it personal unless you get legal advice.
- Buttonwood's AI companion should **explain and inform, not tell you what to buy**.
