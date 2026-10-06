import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.ts';

/** Amount per asset: "SOL" or a token mint address → human units. */
export type Snapshot = Record<string, number>;

/** Everything the bot must remember across restarts to know what it missed. */
export type State = {
  lastSeenAt?: number;        // last heartbeat (ms); downtime = now - this
  cleanShutdown?: boolean;    // false = crash or power loss
  wallet?: {
    address: string;          // reset tracking if the address in .env changes
    lastSignature?: string;   // newest transaction already reported
    snapshot?: Snapshot;      // balances at that point
  };
  botWallet?: {
    address: string;
    network: string;
    lastSignature?: string;   // newest bot-wallet transaction already checked for deposits
  };
};

export function loadState(): State {
  try {
    return JSON.parse(readFileSync(config.stateFile, 'utf8')) as State;
  } catch {
    return {};
  }
}

/** Write to a temp file and rename, so a power cut mid-write can't corrupt the state. */
export function saveState(state: State) {
  mkdirSync(dirname(config.stateFile), { recursive: true });
  const tmp = `${config.stateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, config.stateFile);
}
