// Tells you when a background job keeps failing, and when it recovers. Quiet otherwise.
const ALERT_AFTER = 5;
const failures = new Map<string, { count: number; alerted: boolean }>();

export function healthOk(job: string): string | null {
  const f = failures.get(job);
  failures.delete(job);
  return f?.alerted ? `✅ ${job} is working again.` : null;
}

export function healthFailed(job: string, err: unknown): string | null {
  const f = failures.get(job) ?? { count: 0, alerted: false };
  f.count++;
  failures.set(job, f);
  if (f.count >= ALERT_AFTER && !f.alerted) {
    f.alerted = true;
    return `⚠️ ${job} has failed ${f.count} times in a row: ${(err as Error)?.message ?? err}\nI'll keep retrying. /status for details.`;
  }
  return null;
}

export const failingJobs = () => [...failures.entries()].filter(([, f]) => f.count > 0).map(([job, f]) => `${job} (${f.count} failures)`);
