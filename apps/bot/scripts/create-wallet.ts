// Creates the bot's trading wallet. Run once, ON THE SERVER: npm run wallet:create
// Never overwrites an existing wallet. Never prints the private key or passphrase.
import { Keypair } from '@solana/web3.js';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { encryptSecretKey } from '../src/keystore.ts';

const file = process.env.BOT_WALLET_FILE?.trim() || 'data/bot-wallet.enc.json';

if (existsSync(file)) {
  console.error(`A bot wallet already exists at ${file}. Refusing to overwrite it: any funds in it would be lost.`);
  process.exit(1);
}

let passphrase = process.env.BOT_KEY_PASSPHRASE?.trim();
if (!passphrase) {
  passphrase = randomBytes(32).toString('base64url');
  const line = `BOT_KEY_PASSPHRASE=${passphrase}`;
  const env = readFileSync('.env', 'utf8');
  const updated = /^BOT_KEY_PASSPHRASE=.*$/m.test(env)
    ? env.replace(/^BOT_KEY_PASSPHRASE=.*$/m, line)
    : `${env}${env.endsWith('\n') ? '' : '\n'}# Decrypts the bot wallet file. Back it up somewhere separate from the wallet file.\n${line}\n`;
  writeFileSync('.env', updated, { mode: 0o600 });
  console.log('Generated a random BOT_KEY_PASSPHRASE and saved it in .env');
}

const keypair = Keypair.generate();
mkdirSync(dirname(file), { recursive: true });
const encrypted = encryptSecretKey(keypair.secretKey, keypair.publicKey.toBase58(), passphrase);
writeFileSync(file, JSON.stringify(encrypted, null, 2), { mode: 0o600, flag: 'wx' });

console.log(`✅ Bot wallet created: ${keypair.publicKey.toBase58()}`);
console.log(`   Encrypted key saved to ${file}. Back up this file AND the passphrase, kept apart from each other.`);
