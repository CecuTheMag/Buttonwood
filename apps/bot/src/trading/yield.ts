// Simulated yield on idle paper funds: USDC as if lent out, SOL as if liquid-staked.
// Paper only. Real yield would need the funds actually staked or lent (not built).
import { SOL_MINT, USDC_MINT } from '../tokens.ts';
import { getPositions, getSetting, savePosition, setSetting, transaction } from './store.ts';

export type YieldSettings = { enabled: boolean; usdcApyPct: number; solApyPct: number };
// Conservative defaults: below typical recent rates for USDC lending and SOL liquid staking.
export const DEFAULT_YIELD: YieldSettings = { enabled: true, usdcApyPct: 4, solApyPct: 6 };

export const getYield = (): YieldSettings => ({ ...DEFAULT_YIELD, ...getSetting<Partial<YieldSettings>>('yield', {}) });
export const setYield = (patch: Partial<YieldSettings>) => setSetting('yield', { ...getSetting('yield', {}), ...patch });
export const yieldEarnedUsd = () => getSetting('yield_earned_usd', 0);

const YEAR_MS = 365 * 86_400_000;

/** Pure: interest on `amount` at `apyPct` over `ms`, compounded continuously. */
export const accrued = (amount: number, apyPct: number, ms: number) => amount * (Math.exp(Math.log(1 + apyPct / 100) * (ms / YEAR_MS)) - 1);

/** Called every engine tick; books yield at most once an hour. */
export function accrueYield(prices: Map<string, number>, now = Date.now()) {
  const settings = getYield();
  const last = getSetting<number | null>('yield_last_at', null);
  if (last === null || !settings.enabled) {
    setSetting('yield_last_at', now);
    return;
  }
  const elapsed = Math.min(now - last, 7 * 86_400_000); // never back-pay more than a week after downtime
  if (elapsed < 3_600_000) return;

  const positions = getPositions();
  const cash = positions.get(USDC_MINT);
  const sol = positions.get(SOL_MINT);
  let earnedUsd = 0;
  transaction(() => {
    if (cash && cash.amountRaw > 0n) {
      const interest = accrued(Number(cash.amountRaw) / 1e6, settings.usdcApyPct, elapsed);
      savePosition({ ...cash, amountRaw: cash.amountRaw + BigInt(Math.floor(interest * 1e6)) });
      earnedUsd += interest;
    }
    if (sol && sol.amountRaw > 0n) {
      const reward = accrued(Number(sol.amountRaw) / 1e9, settings.solApyPct, elapsed);
      savePosition({ ...sol, amountRaw: sol.amountRaw + BigInt(Math.floor(reward * 1e9)) }); // cost unchanged: it's income
      earnedUsd += reward * (prices.get(SOL_MINT) ?? 0);
    }
    setSetting('yield_earned_usd', yieldEarnedUsd() + earnedUsd);
    setSetting('yield_last_at', now);
  });
}
