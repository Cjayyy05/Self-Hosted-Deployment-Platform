import { setTimeout } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { dockerDeadline } from '../src/services/docker-deadline.js';

it('aborts a stalled Docker request and rejects even if its client ignores cancellation', async () => {
  let signal: AbortSignal | undefined;
  const bounded = dockerDeadline(({ abortSignal }) => {
    signal = abortSignal;
    return new Promise<void>(() => undefined);
  }, 15);
  await Promise.all([expect(bounded).rejects.toThrow('Docker operation timed out'), setTimeout(25)]);
  expect(signal?.aborted).toBe(true);
});
