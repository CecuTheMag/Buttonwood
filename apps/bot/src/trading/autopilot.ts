// Runs whale following without you: finds wallets, follows the best, drops the idle and the losing.
import { usd } from '../format.ts';
import { getCopySettings } from './copySettings.ts';
import { describeScore, discoverWhales } from './discovery.ts';
import { getSetting, setSetting } from './store.ts';
import { addWhale, lastWhaleActivity, listWhales, setWhaleEnabled } from './whales.ts';

export type AutopilotSettings = {
  enabled: boolean;
  maxWhales: number;          // how many whales to follow at once
  discoverEveryHours: number; // full re-scan interval (refills empty slots sooner)
  inactiveDays: number;       // drop an auto-picked whale that hasn't traded in this long
  evaluatePerRun: number;     // wallets scored per scan (each costs ~100 RPC calls)
};

export const DEFAULT_AUTOPILOT: AutopilotSettings = {
  enabled: true,
  maxWhales: 5,
  discoverEveryHours: 24,
  inactiveDays: 3,
  evaluatePerRun: 15,
};

const REFILL_AFTER_MS = 8 * 3_600_000;
const DAY = 86_400_000;

export const getAutopilot = (): AutopilotSettings => ({ ...DEFAULT_AUTOPILOT, ...getSetting<Partial<AutopilotSettings>>('autopilot', {}) });
export const setAutopilot = (patch: Partial<AutopilotSettings>) => setSetting('autopilot', { ...getSetting('autopilot', {}), ...patch });
export const lastDiscoveryAt = () => getSetting<number | null>('autopilot_last_run', null);

let running = false;
export const isDiscovering = () => running;

/** Called every few minutes. Only does real work when a scan is due. */
export async function autopilotTick(force = false, onProgress?: (text: string) => void): Promise<string[]> {
  const settings = getAutopilot();
  if ((!settings.enabled && !force) || running) return [];
  const messages: string[] = [];
  const now = Date.now();

  // Retire auto-picked whales that went quiet: a whale that never trades never gets judged.
  for (const whale of listWhales().filter((w) => w.enabled && w.auto)) {
    const last = lastWhaleActivity(whale.address) ?? whale.addedAt;
    if (now - last > settings.inactiveDays * DAY) {
      setWhaleEnabled(whale.address, false, `no trades for ${settings.inactiveDays} days`);
      messages.push(`🤖 Dropped ${whale.label}: no trades in ${settings.inactiveDays} days.`);
    }
  }

  const active = listWhales().filter((w) => w.enabled).length;
  const last = lastDiscoveryAt();
  const due = force || last === null || now - last >= settings.discoverEveryHours * 3_600_000
    || (active < settings.maxWhales && now - last >= REFILL_AFTER_MS);
  if (!due || (active >= settings.maxWhales && !force)) return messages;

  running = true;
  setSetting('autopilot_last_run', now); // set first: a crash mid-scan must not cause a scan loop
  try {
    const result = await discoverWhales(settings.evaluatePerRun, onProgress);
    const slots = Math.max(0, settings.maxWhales - active);
    const picks = result.evaluated.filter((c) => c.score.eligible).slice(0, slots);
    for (const pick of picks) {
      addWhale(pick.address, `auto-${pick.address.slice(0, 4)}`, null, {
        auto: true,
        note: `${describeScore(pick.score)}; seen trading ${pick.foundIn.join(', ')}`,
      });
    }

    const eligible = result.evaluated.filter((c) => c.score.eligible).length;
    const lines = [
      `🤖 Autopilot scan: looked at traders in ${result.tokens.length} tokens, found ${result.seen} active wallets, scored ${result.evaluated.length}, ${eligible} met the bar.`,
    ];
    if (picks.length) {
      lines.push('', `Now following (paper, ${usd(getCopySettings().usdPerTrade)} per copy):`);
      for (const p of picks) lines.push(`• auto-${p.address.slice(0, 4)}: ${describeScore(p.score)}`);
      lines.push('', 'Their past results are just the entry ticket. From here they are judged on what copying them actually earns; losers get paused automatically.');
    } else if (slots > 0) {
      const reasons = new Map<string, number>();
      for (const c of result.evaluated) for (const r of c.score.reasons) {
        const key = r.replace(/[\d.]+/g, 'N');
        reasons.set(key, (reasons.get(key) ?? 0) + 1);
      }
      const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${r} (${n})`);
      lines.push('', `Nobody good enough to follow this time. Most common reasons: ${top.join('; ') || 'n/a'}. I'll scan again in ~8h with new wallets.`);
    }
    messages.push(lines.join('\n'));
  } catch (err) {
    messages.push(`🤖 Autopilot scan failed: ${(err as Error).message}. I'll try again later.`);
  } finally {
    running = false;
  }
  return messages;
}
