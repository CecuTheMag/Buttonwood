import { USDC_MINT, isAllowlisted, tokenByMint } from '../tokens.ts';
import type { CopySettings } from './copySettings.ts';
import { getQuote } from './jupiter.ts';
import { getTokenVerdict, saveTokenVerdict, type TokenVerdict } from './store.ts';

const JUPITER_API = process.env.JUPITER_API_URL?.trim() || 'https://lite-api.jup.ag';
const RECHECK_MS = 60 * 60_000; // liquidity and holders change: re-vet hourly

type JupiterToken = {
  id: string;
  symbol: string;
  decimals: number;
  liquidity?: number;
  holderCount?: number;
  isVerified?: boolean;
  audit?: { mintAuthorityDisabled?: boolean; freezeAuthorityDisabled?: boolean; topHoldersPercentage?: number };
  firstPool?: { createdAt?: string };
};

export async function fetchTokenInfo(mint: string): Promise<JupiterToken | undefined> {
  const res = await fetch(`${JUPITER_API}/tokens/v2/search?query=${mint}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`token info ${res.status}`);
  const list = (await res.json()) as JupiterToken[];
  return list.find((t) => t.id === mint);
}

/**
 * Is this token safe enough to buy? Checks liquidity, holders, age, whether the creator can
 * still mint or freeze, holder concentration, and a buy-then-sell quote (can we actually get out?).
 */
export async function vetToken(mint: string, settings: CopySettings): Promise<TokenVerdict> {
  const known = tokenByMint(mint);
  if (isAllowlisted(mint)) return { mint, symbol: known!.symbol, decimals: known!.decimals, safe: true, reason: 'allowlisted', checkedAt: Date.now() };
  const cached = getTokenVerdict(mint);
  if (cached && Date.now() - cached.checkedAt < RECHECK_MS) return cached;

  const info = await fetchTokenInfo(mint);
  if (!info) {
    const verdict = { mint, symbol: `${mint.slice(0, 4)}…`, decimals: known?.decimals ?? 0, safe: false, reason: 'unknown to Jupiter', checkedAt: Date.now() };
    if (known) saveTokenVerdict(verdict);
    return verdict;
  }

  const problems: string[] = [];
  const liquidity = info.liquidity ?? 0;
  if (liquidity < settings.minLiquidityUsd) problems.push(`liquidity $${Math.round(liquidity).toLocaleString('en-US')} < $${settings.minLiquidityUsd.toLocaleString('en-US')}`);
  if ((info.holderCount ?? 0) < settings.minHolders) problems.push(`${info.holderCount ?? 0} holders < ${settings.minHolders}`);
  if (info.audit?.mintAuthorityDisabled !== true) problems.push('creator can still mint more');
  if (info.audit?.freezeAuthorityDisabled !== true) problems.push('creator can freeze holders');
  const top = info.audit?.topHoldersPercentage;
  if (top !== undefined && top > settings.maxTopHoldersPct) problems.push(`top holders own ${top.toFixed(0)}%`);
  const created = info.firstPool?.createdAt ? Date.parse(info.firstPool.createdAt) : undefined;
  if (created !== undefined && (Date.now() - created) / 3_600_000 < settings.minAgeHours) {
    problems.push(`only ${((Date.now() - created) / 3_600_000).toFixed(1)}h old`);
  }

  // Round trip: what would we lose buying and immediately selling? Honeypots and thin pools fail here.
  if (problems.length === 0) {
    try {
      const inRaw = BigInt(Math.round(settings.usdPerTrade * 1e6));
      const buy = await getQuote(USDC_MINT, mint, inRaw, 100);
      const sell = await getQuote(mint, USDC_MINT, BigInt(buy.outAmount), 100);
      const loss = (1 - Number(sell.outAmount) / Number(inRaw)) * 100;
      if (loss > settings.maxRoundTripLossPct) problems.push(`buy-then-sell loses ${loss.toFixed(1)}%`);
    } catch (err) {
      problems.push(`no sell route (${(err as Error).message.slice(0, 60)})`);
    }
  }

  const verdict: TokenVerdict = {
    mint,
    symbol: info.symbol.replace(/^\$/, ''),
    decimals: info.decimals,
    safe: problems.length === 0,
    reason: problems.length ? problems.join('; ') : `passed (liquidity $${Math.round(liquidity).toLocaleString('en-US')}, ${info.holderCount} holders)`,
    checkedAt: Date.now(),
  };
  saveTokenVerdict(verdict);
  return verdict;
}
