export type ScanTone = 'accept' | 'done' | 'fail' | 'repeat';

export interface ScanCue {
  beeps: { hz: number; ms: number }[];
  /** 0 表示不震动。 */
  vibrateMs: number;
}

/** 接受一声短鸣；完成略长；失败两声低鸣；重复一声很短的低鸣且不震动。 */
export const SCAN_CUES: Record<ScanTone, ScanCue> = {
  accept: { beeps: [{ hz: 880, ms: 70 }], vibrateMs: 40 },
  done: { beeps: [{ hz: 880, ms: 140 }], vibrateMs: 80 },
  fail: { beeps: [{ hz: 220, ms: 90 }, { hz: 220, ms: 90 }], vibrateMs: 200 },
  repeat: { beeps: [{ hz: 220, ms: 40 }], vibrateMs: 0 },
};

export interface ScanFeedbackOut {
  beep(hz: number, ms: number): void;
  vibrate(ms: number): void;
}

/** 声音和震动分开关。关掉声音时，震动仍按表走。 */
export function playScanCue(
  tone: ScanTone,
  prefs: { sound: boolean; vibrate: boolean },
  out: ScanFeedbackOut,
): void {
  const cue = SCAN_CUES[tone];
  if (prefs.sound) {
    for (const beep of cue.beeps) out.beep(beep.hz, beep.ms);
  }
  if (prefs.vibrate && cue.vibrateMs > 0) out.vibrate(cue.vibrateMs);
}
