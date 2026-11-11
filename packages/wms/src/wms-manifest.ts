import type { ModuleManifest, ToolDefinition, WorkflowDef } from '@one/core';
import { WMS_RECORDS } from './builtin-records.js';
import { PICKING_BYPASS_WHEN, PICKING_ENTRY_WHEN } from './picking-manifest.js';
import { PUTAWAY_BYPASS_WHEN } from './putaway-manifest.js';
import { ORDER_TRANSITIONS } from './state/order-state-machine.js';

/** 状态中文标签（Profile 流程的展示名） */
const STATE_LABELS: Record<string, string> = {
  created: '已创建',
  received: '已收货',
  picking: '拣货中',
  shipped: '已发货',
  done: '已完成',
  canceled: '已取消',
};

/**
 * 默认流程骨架：从 ORDER_TRANSITIONS（种子誊写源）誊写——M8 行为闭环后，
 * 转移校验读 Profile workflows，种子与校验同源保证新库默认行为不变；
 * 装库后改配置（慢通道 / 模块 contributes）即改行为。
 */
function defaultWorkflows(): Record<string, WorkflowDef> {
  const build = (direction: 'in' | 'out'): WorkflowDef => {
    const stateIds = ['created', ...ORDER_TRANSITIONS[direction].map((t) => t.to)].filter(
      (id, i, arr) => arr.indexOf(id) === i,
    );
    // states[0] 为初始态（约定）：created 恒在首位
    const ordered = ['created', ...stateIds.filter((id) => id !== 'created')];
    const transitions: WorkflowDef['transitions'] = ORDER_TRANSITIONS[direction].map((t) => {
      if (direction === 'out' && t.from === 'created' && t.to === 'picking') {
        return { from: t.from, to: t.to, when: PICKING_ENTRY_WHEN };
      }
      if (direction === 'in' && t.from === 'received' && t.to === 'done') {
        return { from: t.from, to: t.to, when: PUTAWAY_BYPASS_WHEN };
      }
      return { from: t.from, to: t.to };
    });
    if (direction === 'out') {
      transitions.push({ from: 'created', to: 'shipped', when: PICKING_BYPASS_WHEN });
    }
    return {
      states: ordered.map((id) => ({ id, label: STATE_LABELS[id] ?? id })),
      transitions,
    };
  };
  return { inbound: build('in'), outbound: build('out') };
}

/** 工具定义 → manifest 声明（剥离 handler；剩余即 id/label/description/parameters/permission） */
function detachHandler(t: ToolDefinition): Omit<ToolDefinition, 'handler'> {
  const { handler: _handler, ...meta } = t;
  return meta;
}

/**
 * core.wms 基础模块 manifest（M6 模块化种子的声明面）。
 *
 *  - tools 从工具定义派生（detachHandler 剥离 handler）：声明与事实零重复维护；
 *  - workflows.base 消费 defaultWorkflows()（与 M2 硬编码转移表一致，逐流程守卫）；
 *  - fields.provides 三个 shared 扩展字段（规格/分类/单位）——M4 手写种子的 manifest 化；
 *  - settings 四键：defaultAllocation / blockExpiredOutbound（M13，分配策略与过期
 *    出库拦截）+ expiryCriticalDays / expiryWarningDays（M15，效期看板分层阈值）。
 *    新库由 install 从 default 种子；老库（0.1.0 已装，install 幂等短路）不补种子
 *    ——读取方兜底缺省，保证「未配置 = 旧行为」。改值走 profile 慢通道
 *    （propose → confirm）。
 */
export function wmsManifest(toolDefs: ToolDefinition[]): ModuleManifest {
  return {
    id: 'core.wms',
    name: '仓储基础',
    description:
      '仓储管理核心领域：SKU 档案、出入库单据、库存流水与汇总、库位管理（分库位余量、移库与默认库位 DEFAULT）。提供基础扩展字段（规格/分类/单位）与出入库流程骨架。',
    version: '0.1.0',
    capabilities: ['db.read', 'events.subscribe', 'tools.register'],
    fields: {
      provides: [
        { entity: 'sku', key: 'spec', label: '规格', type: 'string' },
        { entity: 'sku', key: 'category', label: '分类', type: 'string' },
        { entity: 'sku', key: 'unit', label: '单位', type: 'string' },
      ],
    },
    aliases: ['仓储'],
    workflowAliases: {
      inbound: ['入库', '入库流程'],
      outbound: ['出库', '出库流程'],
    },
    records: WMS_RECORDS,
    tools: toolDefs.map((tool) => detachHandler(tool)),
    workflows: { base: defaultWorkflows() },
    settings: {
      schema: {
        type: 'object',
        properties: {
          defaultAllocation: {
            type: 'string',
            enum: ['strict', 'fifo', 'fefo'],
            description:
              '出库批次怎么扣，整仓同一条规则，不在出库单上单独指定。strict=严格桶（不分配，没写批次只扣 DEFAULT），fifo=先进先出，fefo=先到期先出。改这一项走 profile.propose，路径 /modules/core.wms/settings/defaultAllocation，确认后新的出库单才按新规则扣',
            default: 'strict',
          },
          blockExpiredOutbound: {
            type: 'boolean',
            description:
              '过期批次出库拦截：开启后单据出库（拣货预检与发货扣减）拒绝效期早于今日的批次（今天到期=临期可出），fifo/fefo 分配自动跳过过期桶；库存调整/移库不受影响',
            default: false,
          },
          expiryCriticalDays: {
            type: 'integer',
            minimum: 1,
            description:
              '效期看板紧急层阈值（天）：剩余天数 ≤ 此值的批次标 critical。必须小于 expiryWarningDays，否则两键一起回落缺省（7/30）。仅影响看板分层展示，不改变过期拦截判定',
            default: 7,
          },
          expiryWarningDays: {
            type: 'integer',
            minimum: 1,
            description:
              '效期看板预警层阈值（天）：剩余天数 ≤ 此值且 > 紧急阈值的批次标 warning。必须大于 expiryCriticalDays，否则两键一起回落缺省（7/30）。仅影响看板分层展示',
            default: 30,
          },
          inboundIncreaseState: {
            type: 'string',
            description:
              '入库单进入该状态时按行增加库存。缺省 received。转移上若写了 effect，以转移为准，本键不生效。改成空串会回落 received',
            default: 'received',
          },
          outboundDecreaseState: {
            type: 'string',
            description:
              '出库单进入该状态时按行扣减库存。缺省 shipped。转移上的 effect 优先。改成空串会回落 shipped',
            default: 'shipped',
          },
          outboundCheckState: {
            type: 'string',
            description:
              '出库单进入该状态时只预检余量、不过账。缺省 picking。转移上的 effect 优先。改成空串会回落 picking',
            default: 'picking',
          },
          specifiedBatchConstraint: {
            type: 'string',
            enum: ['prefer', 'lock'],
            description:
              '出库行写了批次之后能不能换，整仓同一条规则，不在出库单上单独指定。prefer=建议，拣货可以换，库存和退货认换之后的批次；lock=锁定，只能拣这一批。没填批次的行始终不限。退货单和序列号商品始终锁定。改这一项走 profile.propose，路径 /modules/core.wms/settings/specifiedBatchConstraint',
            default: 'prefer',
          },
          specifiedLocationConstraint: {
            type: 'string',
            enum: ['prefer', 'lock'],
            description:
              '出库行写了库位之后能不能换，整仓同一条规则，不在出库单上单独指定。prefer=建议，拣货可以换库位；lock=锁定，只能从这一库位出。没填库位的行始终不限。序列号商品始终锁定库位。改这一项走 profile.propose，路径 /modules/core.wms/settings/specifiedLocationConstraint',
            default: 'prefer',
          },
          putawayCapacity: {
            type: 'string',
            enum: ['off', 'warn', 'block'],
            description:
              '上架库容。off=不看容量；warn=超过容量仍放入，结果里提示；block=放不下就拒绝，货留在收货库位。库位没填容量时不拦。只作用于上架归位，不撤回收货',
            default: 'off',
          },
          numbering: {
            type: 'object',
            description:
              '各处自动编号的模板。键是位置，值是模板字符串。位置：order.in 入库单、order.out 出库单、order.asn 到货预报、order.return.in 客退、order.return.out 退供、picking 拣货单、wave 波次、stocktake 盘点单、sku 商品、partner.supplier 供应商、partner.customer 客户、location 库位、warehouse 仓库、lpn 托盘。模板由字面量和记号组成，必须有且只有一个序号。记号：{yyyy} 四位年、{yy} 两位年、{MM} 月、{dd} 日、{yyyyMMdd} 年月日、{seq} 或 {seq:4} 补零序号（位数 1 到 8）。写了日就每天从 1 重新计，只写到月就每月重计，只写年就每年重计，都不写就一直累加。没写的位置用内置模板。改这一项走 profile.propose。先用 wms.numbering.preview，op 用返回的 patchOp，path 用返回的 path，value 用返回的 numbering 整对象并只改用户点名的位置。确认后，新建时不填编号才按新规则生成，已经存在的编号不变。',
            default: {},
          },
        },
      },
    },
  };
}
