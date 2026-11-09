import type { WmsWorkspace } from '../wms.js';
import { specifiedConstraint, type SpecifiedConstraint } from '../state/execution-policy.js';

/** core.wms 模块设置读取结果：快照 Record<string, unknown> 窄化后的键 */
export interface WmsSettings {
  defaultAllocation: 'strict' | 'fifo' | 'fefo';
  blockExpiredOutbound: boolean;
  /** 出库行写了批次时：建议可以换，锁定不能换。没写的行始终不限。 */
  specifiedBatchConstraint: SpecifiedConstraint;
  /** 出库行写了库位时：建议可以换，锁定不能换。没写的行始终不限。 */
  specifiedLocationConstraint: SpecifiedConstraint;
  /** 库位容量：off 不看，warn 放行并提示，block 放不下就拒绝。没填容量的库位不拦。 */
  putawayCapacity: 'off' | 'warn' | 'block';
  /** 效期看板分层阈值（天）：M15 起从 settings 读（缺省 7 / 30） */
  expiryCriticalDays: number;
  expiryWarningDays: number;
  /**
   * 未在转移上声明 effect 时，进入这些状态才联动库存。
   * 缺省 received / shipped / picking = 旧行为。改名后的自定义流程用这三键对准。
   */
  inboundIncreaseState: string;
  outboundDecreaseState: string;
  outboundCheckState: string;
}

/**
 * 读 core.wms 模块设置（M13；M15 起包级导出——server 效期看板端点同源消费）。
 * 快照是脏面：老库无种子（0.1.0 已装，install 幂等短路不补）、慢通道可写
 * 任意值——此处窄化 + 兜底，非法/缺失回落代码缺省（strict / false / 7 / 30 /
 * received / shipped / picking），保证「未配置 = 旧行为」。改值走 profile 慢通道（propose → confirm），
 * 确认后下一次建单/流转即生效。
 *
 * 阈值两键联动兜底（M15）：critical 必须 ≥1 且严格小于 warning，任一键脏值
 * 或次序不合法 → 两键一起回落缺省（7 / 30）——分层边界不交叉是 level 语义
 * 成立的前提，宁可整体回落不出「warning < critical」的畸形配置。
 */
export function readWmsSettings(ws: WmsWorkspace): WmsSettings {
  const raw = ws.profile.getSnapshot().modules['core.wms']?.settings ?? {};
  const da = raw.defaultAllocation;
  const capacity = raw.putawayCapacity;
  const cd = raw.expiryCriticalDays;
  const wd = raw.expiryWarningDays;
  const thresholdsOk =
    typeof cd === 'number' &&
    Number.isInteger(cd) &&
    cd >= 1 &&
    typeof wd === 'number' &&
    Number.isInteger(wd) &&
    wd > cd;
  return {
    defaultAllocation: da === 'strict' || da === 'fifo' || da === 'fefo' ? da : 'strict',
    blockExpiredOutbound: raw.blockExpiredOutbound === true,
    specifiedBatchConstraint: specifiedConstraint(raw.specifiedBatchConstraint),
    specifiedLocationConstraint: specifiedConstraint(raw.specifiedLocationConstraint),
    putawayCapacity: capacity === 'warn' || capacity === 'block' ? capacity : 'off',
    expiryCriticalDays: thresholdsOk ? cd : 7,
    expiryWarningDays: thresholdsOk ? wd : 30,
    inboundIncreaseState: stateName(raw.inboundIncreaseState, 'received'),
    outboundDecreaseState: stateName(raw.outboundDecreaseState, 'shipped'),
    outboundCheckState: stateName(raw.outboundCheckState, 'picking'),
  };
}

function stateName(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback;
}
