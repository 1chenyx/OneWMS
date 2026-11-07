import type { ModuleManifest } from '@one/core';

/**
 * module.reversal —— 单据冲销。
 *
 * 只贡献转移、不新增状态：停用（when 不成立）后这两条边不可达，
 * 入库回到「收货后不能取消」、出库回到「发货后不能取消」。
 * 卸载按转移上的 providedBy 摘边（两端状态属于基础流程，不能靠摘状态带走）。
 *
 * 效应写在转移上，不改 received/shipped 的默认效应：
 *  - 已收货 → 取消：按行扣回（effect=decrease）
 *  - 已发货 → 取消：按行加回（effect=increase）
 * 上架之后单据已离开 received，本模块不冲销已改派的货。
 */
export function reversalManifest(): ModuleManifest {
  return {
    id: 'module.reversal',
    name: '单据冲销',
    description:
      '可选的单据回冲：已收货的入库单可以取消并扣回库存，已发货的出库单可以取消并把库存加回。按单据行上的库位和批次回冲。停用本模块后这两条取消转移消失，已完成的历史单据不变。上架改派之后的入库单不在本模块范围内。',
    version: '0.1.0',
    capabilities: ['db.read', 'events.subscribe'],
    dependencies: { modules: ['core.wms'] },
    workflows: {
      contributes: {
        inbound: {
          states: [],
          transitions: [
            {
              from: 'received',
              to: 'canceled',
              when: 'module.reversal.enabled',
              effect: 'decrease',
            },
          ],
        },
        outbound: {
          states: [],
          transitions: [
            {
              from: 'shipped',
              to: 'canceled',
              when: 'module.reversal.enabled',
              effect: 'increase',
            },
          ],
        },
      },
    },
  };
}
