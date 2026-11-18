const CONTROL_TIMEOUT_MS = 5_000;

export async function dockerDeadline<T>(
  operation: (options: { abortSignal: AbortSignal }) => Promise<T>,
  timeout = CONTROL_TIMEOUT_MS,
): Promise<T> {
  const abortSignal = AbortSignal.timeout(timeout);
  let onAbort: () => void = () => undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    onAbort = () => { reject(new Error('Docker operation timed out', { cause: abortSignal.reason })); };
    abortSignal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation({ abortSignal }), expired]);
  } finally {
    abortSignal.removeEventListener('abort', onAbort);
  }
}
