export function reportRenderMeasurement(now = () => performance.now(), utcNow = () => new Date().toISOString()) {
  const started = now(), requestedAt = utcNow();
  let completed = false;
  return {
    requestedAt,
    complete(receipt?: string) {
      if (completed || !receipt) return undefined;
      completed = true;
      return { receipt, durationMs: Math.max(0, Math.round(now() - started)) };
    },
  };
}
