export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

export type Token = { symbol: string; mint: string; decimals: number };

/**
 * The trading allowlist: the bot only ever trades these (vs USDC).
 * Large, liquid tokens only. Add more carefully: check liquidity and RugCheck first.
 */
export const TOKENS: Token[] = [
  { symbol: 'SOL', mint: SOL_MINT, decimals: 9 },
  { symbol: 'USDC', mint: USDC_MINT, decimals: 6 },
  { symbol: 'USDT', mint: USDT_MINT, decimals: 6 },
  { symbol: 'JUP', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', decimals: 6 },
  { symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5 },
  { symbol: 'WIF', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals: 6 },
  { symbol: 'JTO', mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', decimals: 9 },
  { symbol: 'PYTH', mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', decimals: 6 },
  { symbol: 'RAY', mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', decimals: 6 },
];

/** Tokens you can buy or sell against USDC. */
export const TRADABLE = TOKENS.filter((t) => t.mint !== USDC_MINT);

/** Mints that count as "money" when reading a swap: what you pay with or sell into. */
export const BASE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

/**
 * Every token the bot knows: the allowlist plus tokens it learned from whale trades
 * (only vetted ones can be BOUGHT; see tokenInfo.ts). Lookups are by mint.
 */
const registry = new Map<string, Token>(TOKENS.map((t) => [t.mint, t]));
export function registerToken(token: Token, overwrite = false) {
  if (overwrite ? !isAllowlistedMint(token.mint) : !registry.has(token.mint)) registry.set(token.mint, token);
}
const isAllowlistedMint = (mint: string) => TOKENS.some((t) => t.mint === mint);
export const tokenByMint = (mint: string) => registry.get(mint);
export const isAllowlisted = (mint: string) => TRADABLE.some((t) => t.mint === mint);

/** "sol", "SOL" or a mint → Token. Allowlisted tokens win over learned ones with the same symbol. */
export function findToken(input: string): Token | undefined {
  const query = input.trim();
  const bySymbol = (t: Token) => t.symbol.toLowerCase() === query.toLowerCase() || t.mint === query;
  return TOKENS.find(bySymbol) ?? [...registry.values()].find(bySymbol);
}

export function symbolFor(asset: string): string {
  if (asset === 'SOL') return 'SOL';
  return tokenByMint(asset)?.symbol ?? `${asset.slice(0, 4)}…${asset.slice(-4)}`;
}

/** Raw base units ↔ human amounts. */
export const toUi = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;
export const toRaw = (ui: number, decimals: number) => BigInt(Math.floor(ui * 10 ** decimals));
