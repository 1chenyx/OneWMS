/** 同一字符串在这个时间内来第二次，丢掉。厂商经常键盘和广播各发一次。 */
export const SCAN_DEDUPE_MS = 400;

export function isRepeatScan(
  previous: { raw: string; at: number } | null,
  next: { raw: string; at: number },
): boolean {
  if (!previous || previous.raw !== next.raw) return false;
  const delta = next.at - previous.at;
  return delta >= 0 && delta <= SCAN_DEDUPE_MS;
}
