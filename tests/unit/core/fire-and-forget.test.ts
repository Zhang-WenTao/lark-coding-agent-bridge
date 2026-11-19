import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireAndForget } from '../../../src/core/fire-and-forget';
import { log } from '../../../src/core/logger';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fireAndForget', () => {
  it('logs a failure with where it came from instead of leaving it unhandled', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const boom = new Error('card update 502');
      fireAndForget(Promise.reject(boom), 'card', { step: 'heartbeat', scope: 'oc_x' });
      await new Promise((r) => setTimeout(r, 10));
      expect(fail).toHaveBeenCalledWith('card', boom, { step: 'heartbeat', scope: 'oc_x' });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('stays quiet when the work succeeds', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    fireAndForget(Promise.resolve('ok'), 'card');
    await new Promise((r) => setTimeout(r, 10));
    expect(fail).not.toHaveBeenCalled();
  });
});
