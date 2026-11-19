import { describe, expect, it } from 'vitest';
import { getCronMaxConcurrentJobs, getCronRunMaxMs, type AppConfig } from '../../../src/config/schema';

const cfg = (preferences: Record<string, unknown>): AppConfig => ({ preferences }) as unknown as AppConfig;

describe('cron limits', () => {
  it('runs one job at a time unless told otherwise', () => {
    expect(getCronMaxConcurrentJobs(cfg({}))).toBe(1);
    expect(getCronMaxConcurrentJobs(cfg({ cronMaxConcurrentJobs: 0 }))).toBe(1);
    expect(getCronMaxConcurrentJobs(cfg({ cronMaxConcurrentJobs: '2' }))).toBe(1);
    expect(getCronMaxConcurrentJobs(cfg({ cronMaxConcurrentJobs: 2.7 }))).toBe(2);
    expect(getCronMaxConcurrentJobs(cfg({ cronMaxConcurrentJobs: 99 }))).toBe(5);
  });

  it('has no run-time cap unless one is set', () => {
    expect(getCronRunMaxMs(cfg({}))).toBeUndefined();
    expect(getCronRunMaxMs(cfg({ cronRunMaxMinutes: 0 }))).toBeUndefined();
    expect(getCronRunMaxMs(cfg({ cronRunMaxMinutes: 60 }))).toBe(3_600_000);
    expect(getCronRunMaxMs(cfg({ cronRunMaxMinutes: 0.5 }))).toBe(60_000);
    expect(getCronRunMaxMs(cfg({ cronRunMaxMinutes: 100_000 }))).toBe(24 * 3_600_000);
  });
});
