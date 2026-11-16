/** 连着的时候每 15 秒看一次健康。失败后 1s、2s、4s，上限 30s。 */
export const HEALTH_INTERVAL_MS = 15_000;

export function nextDelayMs(failures: number): number {
  if (failures <= 0) return HEALTH_INTERVAL_MS;
  return Math.min(30_000, 1000 * 2 ** (failures - 1));
}
