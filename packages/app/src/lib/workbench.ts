import type { Page } from '../app-nav';

/**
 * 作业台的排布规则。
 *
 * 流水线的**形状**不在这里——它来自 Profile 的 workflows 配置（states 数组顺序
 * 就是流程顺序，label 就是节点名）。模块贡献新状态，作业台自动多一个节点。
 * 这里只回答两件前端才知道的事：
 *   1. 哪些状态是终态（没有「下一步」，不该排进待办流水线）；
 *   2. 单据停在某个状态时，该去哪一页把它推进。
 *
 * 「去哪一页」按 StagePage 各步骤的入口守卫同构推导：模块关掉时链路直接跨过
 * 那一步，不给用户指一条走不通的路。core 不认识 nav，所以这份映射长在 app 层。
 */

/** 车道：单据方向 ↔ 流程 id */
export type Lane = 'in' | 'out';

export const LANES: readonly Lane[] = ['in', 'out'];

export const LANE_LABEL: Record<Lane, string> = { in: '入库', out: '出库' };

export const WORKFLOW_OF_LANE: Record<Lane, string> = { in: 'inbound', out: 'outbound' };

/** 终态：只做汇总，不排进流水线 */
const TERMINAL_STATES: ReadonlySet<string> = new Set(['done', 'canceled']);

export function isTerminalState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

export type ModuleFlags = Record<string, { enabled?: boolean } | undefined>;

const on = (modules: ModuleFlags, id: string): boolean => modules[id]?.enabled === true;

/**
 * 停在 state 的单据该去哪一页推进。
 *
 * 返回 undefined = 这一步没有专属页面（新模块贡献的陌生状态，或链路被关空）。
 * 节点照实显示数量，但不可点——宁可点不动，也不要跳到一页空清单上。
 */
export function stagePage(lane: Lane, state: string, modules: ModuleFlags): Page | undefined {
  if (lane === 'in') {
    switch (state) {
      // 收货动作长在入库单页；上架完成后也回入库单结束
      case 'created':
      case 'announced':
      case 'putaway':
        return 'inbound';
      // 收货后：质检开着先质检，否则上架，都没有就回入库单结束
      case 'received':
        return on(modules, 'module.qc')
          ? 'qc'
          : on(modules, 'module.putaway')
            ? 'putaway'
            : 'inbound';
      case 'inspected':
        return on(modules, 'module.putaway') ? 'putaway' : 'inbound';
      default:
        return undefined;
    }
  }

  switch (state) {
    // 组波开着先组波；否则直接开拣货单；都没有就回出库单发货
    case 'created':
    case 'waved':
      return on(modules, 'module.wave')
        ? 'wave'
        : on(modules, 'module.picking')
          ? 'pickings'
          : 'outbound';
    case 'picking':
      return 'pickings';
    case 'picked':
      return on(modules, 'module.review')
        ? 'review'
        : on(modules, 'module.pack')
          ? 'pack'
          : on(modules, 'module.load')
            ? 'load'
            : 'outbound';
    case 'reviewed':
      return on(modules, 'module.pack')
        ? 'pack'
        : on(modules, 'module.load')
          ? 'load'
          : 'outbound';
    case 'packed':
      return on(modules, 'module.load') ? 'load' : 'outbound';
    case 'loaded':
      return 'outbound';
    default:
      return undefined;
  }
}
