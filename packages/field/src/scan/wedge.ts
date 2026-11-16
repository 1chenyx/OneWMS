/** 字符间隔小于这个值，算扫描枪而不是手指。 */
export const SCAN_GAP_MS = 30;

/** 间隔大于这个值，算人工输入。只在焦点位于扫码步时，回车才提交。 */
export const HUMAN_GAP_MS = 80;

export interface WedgeState {
  buffer: string;
  lastAt: number;
  /** 已经出现过一次小于 SCAN_GAP_MS 的间隔。回车即使不在扫码步也提交。 */
  fast: boolean;
}

export function emptyWedge(): WedgeState {
  return { buffer: '', lastAt: 0, fast: false };
}

export interface WedgeOutcome {
  state: WedgeState;
  /** trim 之后的字符串。空扫是 null。 */
  emit: string | null;
  /** 快扫的字符不要再落进当前输入框。 */
  swallow: boolean;
}

/**
 * 全局按键缓冲。
 * 快扫以 Enter 结束，不要求焦点。慢速输入只在扫码步里提交。
 */
export function reduceWedge(state: WedgeState, key: string, at: number, focusInScanStep: boolean): WedgeOutcome {
  if (key === 'Enter') {
    const raw = state.buffer.trim();
    const submit = raw.length > 0 && (state.fast || focusInScanStep);
    return { state: emptyWedge(), emit: submit ? raw : null, swallow: submit };
  }
  if (key.length !== 1) return { state, emit: null, swallow: false };
  const gap = state.buffer ? at - state.lastAt : HUMAN_GAP_MS + 1;
  if (!state.buffer || gap > HUMAN_GAP_MS) {
    return { state: { buffer: key, lastAt: at, fast: false }, emit: null, swallow: false };
  }
  const fast = state.fast || gap < SCAN_GAP_MS;
  return { state: { buffer: state.buffer + key, lastAt: at, fast }, emit: null, swallow: fast };
}
