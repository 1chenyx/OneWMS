export type ScanSource = 'wedge' | 'broadcast' | 'camera';

export interface ScanEvent {
  /** trim 之后、尚未按步骤解释 */
  raw: string;
  source: ScanSource;
  at: number;
}
