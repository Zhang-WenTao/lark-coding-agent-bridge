import type { ProfileConfig } from '../config/profile-schema';
import { claudeAccountPool } from './claude/accounts';
import { readClaudeQuota, readClaudeQuotaReadings } from './claude/quota';
import { readCodexQuota } from './codex/quota';
import type { AgentKind } from './registry';
import type { AgentRunOptions } from './types';

export {
  fullestQuotaWindow,
  quotaResetAt,
  type QuotaReading,
  type QuotaReadOptions,
  type QuotaWindow,
} from './quota-window';
import type { QuotaReading, QuotaReadOptions } from './quota-window';

const QUOTA_READERS: Record<AgentKind, (profileConfig: ProfileConfig, opts: QuotaReadOptions) => Promise<QuotaReading | undefined>> = {
  claude: (_profileConfig, opts) => readClaudeQuota(opts),
  codex: (profileConfig, opts) => readCodexQuota(profileConfig.codex, opts),
};

/** A per-window ceiling on account switch lines (AgentRunOptions.accountLineCap). */
export type AccountLineCap = NonNullable<AgentRunOptions['accountLineCap']>;

/**
 * Whether some account of the profile is still below `cap` in every capped
 * window, by what the accounts last reported. Undefined when it cannot be
 * told: a single account, or an agent without several accounts. Never throws.
 */
const ACCOUNT_ROOM: Partial<Record<AgentKind, (profileDir: string, cap: AccountLineCap) => Promise<boolean | undefined>>> = {
  claude: async (profileDir, cap) => {
    const pool = claudeAccountPool(profileDir);
    await pool.refresh();
    if (!pool.multi) return undefined;
    return pool.pickReady(undefined, cap) !== undefined;
  },
};

export async function accountRoomUnderCap(
  profileConfig: ProfileConfig,
  profileDir: string | undefined,
  cap: AccountLineCap,
): Promise<boolean | undefined> {
  const check = ACCOUNT_ROOM[profileConfig.agentKind];
  if (!check || !profileDir) return undefined;
  try {
    return await check(profileDir, cap);
  } catch {
    return undefined;
  }
}

/** A quota window as a run reported it: used percent, and its reset as epoch ms when known. */
export interface ReportedWindow {
  usedPercent: number;
  resetsAt?: number;
}

const FIVE_HOUR_REPORTS: Partial<Record<AgentKind, (profileDir: string) => ReportedWindow | undefined>> = {
  // Every run records its account's windows (`rate_limit_event`); the account
  // that reported last is the one the latest run used.
  claude: (profileDir) => {
    const latest = claudeAccountPool(profileDir)
      .status()
      .filter((entry) => entry.state?.windows.five_hour)
      .sort((a, b) => (b.state?.updatedAt ?? 0) - (a.state?.updatedAt ?? 0))[0];
    const window = latest?.state?.windows.five_hour;
    return window
      ? { usedPercent: window.usedPercent, ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}) }
      : undefined;
  },
};

/**
 * The 5-hour window of the account the latest run used, as that run reported
 * it — the bridge's own record, no CLI call, so it is synchronous. Undefined
 * when the agent keeps no such record or nothing was reported. Never throws.
 */
export function reportedFiveHourWindow(
  profileConfig: Pick<ProfileConfig, 'agentKind'>,
  profileDir: string | undefined,
): ReportedWindow | undefined {
  const read = FIVE_HOUR_REPORTS[profileConfig.agentKind];
  if (!read || !profileDir) return undefined;
  try {
    return read(profileDir);
  } catch {
    return undefined;
  }
}

/** Undefined when the CLI cannot say — callers must treat that as "unknown", never as 0%. Never throws. */
export async function readAgentQuota(profileConfig: ProfileConfig, opts: QuotaReadOptions): Promise<QuotaReading | undefined> {
  try {
    const reading = await QUOTA_READERS[profileConfig.agentKind]?.(profileConfig, opts);
    return reading && (reading.windows.length > 0 || reading.blocked) ? reading : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every account's reading — one for a single-account profile, one per
 * account taking part with several (Claude). Empty when none can be read.
 */
export async function readAgentQuotaReadings(profileConfig: ProfileConfig, opts: QuotaReadOptions): Promise<QuotaReading[]> {
  try {
    const readings =
      profileConfig.agentKind === 'claude'
        ? await readClaudeQuotaReadings(opts)
        : [await readAgentQuota(profileConfig, opts)].filter((r): r is QuotaReading => r !== undefined);
    return readings.filter((r) => r.windows.length > 0 || r.blocked);
  } catch {
    return [];
  }
}
