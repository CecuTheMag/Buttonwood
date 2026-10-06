# Security policy

Buttonwood holds a wallet key and can move funds, so security bugs matter.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private
[security advisory form](../../security/advisories/new) for this repository instead.
Include what you found, how to reproduce it, and what an attacker could do with it.

## What counts

Especially interested in anything that could:

- move funds anywhere other than `OWNER_PHANTOM_ADDRESS`
- let someone other than `TELEGRAM_OWNER_ID` control the bot
- leak the bot wallet key, its passphrase, or the Telegram token
- bypass the risk manager or `/stop`

## If you run Buttonwood

- Never commit `.env`, `data/`, or `*.enc.json` (the `.gitignore` covers them).
- Back up `data/bot-wallet.enc.json` and `BOT_KEY_PASSPHRASE` **separately**.
- If your Telegram bot token leaks: `/revoke` it in @BotFather immediately.
- Turn on Telegram two-step verification. Your Telegram account controls the bot.
- Only put money in the bot wallet that you can afford to lose.

See [docs/security-and-risk.md](docs/security-and-risk.md) for the full picture.
