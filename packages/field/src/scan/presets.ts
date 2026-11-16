/** 广播预置。只是起点，现场可以改，不靠发版。 */

export interface ScanPreset {
  id: string;
  name: string;
  action: string;
  extra: string;
}

export const SCAN_PRESETS: readonly ScanPreset[] = [
  { id: 'generic', name: '通用', action: 'onewms.scan', extra: 'data' },
  { id: 'zebra', name: '斑马', action: '', extra: 'com.symbol.datawedge.data_string' },
  { id: 'urovo', name: '优博讯', action: 'android.intent.ACTION_DECODE_DATA', extra: 'barcode_string' },
  { id: 'nlscan', name: '东集 / 新大陆', action: 'nlscan.action.SCANNER_RESULT', extra: 'SCAN_BARCODE1' },
];

export const ZEBRA_ACTION_HINT = '填 DataWedge 的 Intent action';
