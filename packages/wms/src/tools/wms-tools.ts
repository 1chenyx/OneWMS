import { randomUUID } from 'node:crypto';
import type { ToolContext, ToolDefinition } from '@one/core';
import type { WmsWorkspace } from '../wms.js';
import { DEFAULT_BATCH_NO, DEFAULT_LOCATION_ID, WMS_EVENT_TYPES } from '../events/catalog.js';
import {
  assertTransition,
  WORKFLOW_BY_DIRECTION,
  type OrderDirection,
} from '../state/order-state-machine.js';
import { requiresAvailabilityCheck, stockEffectOf } from '../state/inventory-effect.js';
import {
  AllocationInsufficientError,
  BatchExpiryMismatchError,
  ExpiredBatchError,
  InsufficientStockError,
  LocationAlreadyExistsError,
  LocationNotFoundError,
  OrderAlreadyExistsError,
  OrderNotFoundError,
  SkuAlreadyExistsError,
  SkuNotFoundError,
  WorkflowNotFoundError,
} from '../errors.js';

/**
 * 领域工具（DESIGN.md §4 宪法：AI 触碰业务数据的唯一通道）。
 *
 * 护栏模式（每个 write 工具三步，缺一不可）：
 *  1. ws.sync()——校验前先追账，投影读到的是最新事实；
 *  2. 业务校验——编码唯一 / SKU 存在 / 状态机合法 / 库存不为负；
 *  3. ctx.appendEvent——事件落账后再 sync()，返回值可携带新状态。
 * 校验失败绝不落事件（命令失败 ≠ 事实，§4.3）。
 *
 * 工具 id 命名空间 `wms.动词.名词`；description 原文注入 function calling，
 * 措辞精确（§6 决策：AI 组装的匹配逻辑就靠它）。
 */

/**
 * 工具定义包装器：handler 参数的逆变位置决定了具体参数类型无法直接赋给
 * ToolDefinition（unknown）——此处集中做一次受控窄化，工具定义处保留精确类型。
 */
function def<P>(tool: ToolDefinition<P>): ToolDefinition {
  return { ...tool, handler: (params: unknown, ctx: ToolContext) => tool.handler(params as P, ctx) };
}

/**
 * 库位解析（M10）：缺省/显式 DEFAULT → 虚拟桶（不占 wms_location 表）；
 * 否则查实体库位，未建即拒。所有携带库位的工具共用这一个口子。
 */
function resolveLocation(
  ws: WmsWorkspace,
  code: string | undefined,
): { locationId: string; locationCode: string } {
  if (!code || code === DEFAULT_LOCATION_ID) {
    return { locationId: DEFAULT_LOCATION_ID, locationCode: DEFAULT_LOCATION_ID };
  }
  const loc = ws.locations.byCode(code);
  if (!loc) throw new LocationNotFoundError(code);
  return { locationId: loc.id, locationCode: loc.locationCode };
}

/** 行库位 id → 编码（审计/返回值显示；DEFAULT 虚拟桶直通，实体缺失兜底 id） */
function codeOfLocation(ws: WmsWorkspace, locationId: string): string {
  if (locationId === DEFAULT_LOCATION_ID) return DEFAULT_LOCATION_ID;
  return ws.locations.byId(locationId)?.locationCode ?? locationId;
}

/**
 * 批次解析（M11）：缺省/空串 → 虚拟批次 DEFAULT（不携带效期）；显式 DEFAULT
 * 批次 + 效期 → 拒（保留词语义纯净——它是「未指定批次」的归宿，不是真批次）。
 * 批次随首条流水诞生（无实体表），显式批次号本身无需存在性校验。
 */
function resolveBatch(
  batchNo: string | undefined,
  batchExpiryDate: string | undefined,
): { batchNo: string; batchExpiryDate?: string } {
  if (!batchNo || batchNo === DEFAULT_BATCH_NO) {
    if (batchExpiryDate) {
      throw new Error('TOOL_REJECTED: DEFAULT 是虚拟批次（未指定批次的归宿），不携带效期');
    }
    return { batchNo: DEFAULT_BATCH_NO };
  }
  return { batchNo, batchExpiryDate };
}

/**
 * 批次效期一致性（M11）：同 (SKU, 批次) 首个非空效期登记后，后继流水必须一致。
 * 未登记（null）→ 放行（首条登记或后补）；不一致 → BatchExpiryMismatchError。
 * 只对带效期的真批次调用（DEFAULT 已在 resolveBatch 挡掉效期）。
 */
function assertExpiryConsistent(
  ws: WmsWorkspace,
  skuId: string,
  skuCode: string,
  batchNo: string,
  expiryDate: string | undefined,
): void {
  if (!expiryDate) return;
  const known = ws.inventory.expiryOfBatch(skuId, batchNo);
  if (known !== null && known !== expiryDate) {
    throw new BatchExpiryMismatchError(skuCode, batchNo, known, expiryDate);
  }
}

/** core.wms 模块设置读取结果（M13）：快照 Record<string, unknown> 窄化后的两键 */
interface WmsSettings {
  defaultAllocation: 'strict' | 'fifo' | 'fefo';
  blockExpiredOutbound: boolean;
}

/**
 * 读 core.wms 模块设置（M13）。快照是脏面：老库无种子（0.1.0 已装，install
 * 幂等短路不补）、慢通道可写任意值——工具层窄化 + 兜底，非法/缺失回落代码
 * 缺省（strict / false），保证「未配置 = M12 行为」。改值走 profile 慢通道
 * （propose → confirm），确认后下一次建单/流转即生效。
 */
function readSettings(ws: WmsWorkspace): WmsSettings {
  const raw = ws.profile.getSnapshot().modules['core.wms']?.settings ?? {};
  const da = raw.defaultAllocation;
  return {
    defaultAllocation: da === 'strict' || da === 'fifo' || da === 'fefo' ? da : 'strict',
    blockExpiredOutbound: raw.blockExpiredOutbound === true,
  };
}

/** 过期判定（M13）：效期早于今日（UTC）= 过期；今天到期 = 临期可出（ISO 日期字典序即时间序）。
 *  类型谓词：true ⇒ 效期非空（拦截处据此收窄 expiry 供错误消息使用）。 */
function isExpired(batchExpiryDate: string | null, today: string): batchExpiryDate is string {
  return batchExpiryDate !== null && batchExpiryDate < today;
}

/** 余量守卫错误消息的桶标识：DEFAULT 批次不加批次后缀（与 M10 消息逐字节兼容） */
function bucketLabel(skuCode: string, locationCode: string, batchNo: string): string {
  return batchNo === DEFAULT_BATCH_NO
    ? `${skuCode}@${locationCode}`
    : `${skuCode}@${locationCode}@${batchNo}`;
}

/**
 * 批次分配（M12）：出库单启用 allocation 时，把未指定批次的行按策略拆分为具体批次行。
 *  - fifo：桶按首笔流水时间升序（firstSeenAt）；fefo：按效期升序，无期批次（含
 *    DEFAULT）排最后——同段并列回落 firstSeenAt，再并列用 batchNo 字典序稳定化；
 *  - 分配范围 = 行库位内的全部余量桶（不跨库位）；按序扣到足额，一行可拆多批次；
 *  - 显式指定 batchNo 的行原样保留（显式优先，不参与分配）；
 *  - 各批次合计不足 → AllocationInsufficientError（纯计算不落事件，fail-fast）；
 *  - 过期桶（M13）：blockExpired 开启时跳过效期早于今日的桶——不让过期货堵死
 *    整单，可用桶凑不齐仍走 AllocationInsufficientError。
 * 分配是建单时的命令侧计算：事件里落的已是带批次的多行，与 M11 事件形态
 * 逐字节同构——零投影改动、旧节点可同步消费。
 */
function expandAllocatedLines(
  ws: WmsWorkspace,
  lines: {
    skuCode: string;
    quantity: number;
    locationCode?: string;
    batchNo?: string;
    batchExpiryDate?: string;
  }[],
  strategy: 'fifo' | 'fefo',
  blockExpired: boolean,
): {
  skuCode: string;
  quantity: number;
  locationCode?: string;
  batchNo?: string;
  batchExpiryDate?: string;
}[] {
  const today = new Date().toISOString().slice(0, 10);
  return lines.flatMap((l, i) => {
    if (l.batchNo) return [l]; // 显式批次优先
    // 防御性结构校验（主校验循环兜底再跑一遍，此处保证分配自身不被坏输入绕过）
    if (typeof l?.skuCode !== 'string' || !l.skuCode) {
      throw new Error(`TOOL_REJECTED: 第 ${i + 1} 行缺少 skuCode`);
    }
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) {
      throw new Error(`TOOL_REJECTED: 第 ${i + 1} 行数量必须是正整数`);
    }
    const sku = ws.skus.byCode(l.skuCode);
    if (!sku) throw new SkuNotFoundError(l.skuCode);
    const loc = resolveLocation(ws, l.locationCode);

    const buckets = ws.inventory.batchesOf(sku.id, loc.locationId);
    // M13：拦截开启时跳过过期桶（效期早于今天；今天到期 = 临期可用）
    const usable = blockExpired ? buckets.filter((b) => !isExpired(b.batchExpiryDate, today)) : buckets;
    usable.sort((a, b) => {
      if (strategy === 'fefo') {
        const ae = a.batchExpiryDate;
        const be = b.batchExpiryDate;
        if (ae === null && be !== null) return 1; // 无期批次最后（含 DEFAULT）
        if (ae !== null && be === null) return -1;
        if (ae !== null && be !== null && ae !== be) return ae < be ? -1 : 1;
      }
      if (a.firstSeenAt !== b.firstSeenAt) return a.firstSeenAt < b.firstSeenAt ? -1 : 1;
      return a.batchNo < b.batchNo ? -1 : a.batchNo > b.batchNo ? 1 : 0;
    });

    let remaining = l.quantity;
    const parts: { batchNo: string; quantity: number }[] = [];
    for (const b of usable) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, b.quantity);
      parts.push({ batchNo: b.batchNo, quantity: take });
      remaining -= take;
    }
    if (remaining > 0) {
      throw new AllocationInsufficientError(
        l.skuCode,
        loc.locationCode,
        l.quantity,
        l.quantity - remaining,
      );
    }
    // 拆分行不带效期（出库行效期纪律不变——效期随入库声明）
    return parts.map((p) => ({ ...l, batchNo: p.batchNo, quantity: p.quantity }));
  });
}

/** 装配工厂：注入「workspaceId → 绑定工作区」的解析器（WmsDomain 装配期提供） */
export function createWmsTools(
  resolveWorkspace: (workspaceId: string) => WmsWorkspace,
): ToolDefinition[] {
  // ── SKU ──────────────────────────────────────────────

  const skuCreate: ToolDefinition<{ skuCode: string; name: string; extData?: Record<string, unknown> }> = {
    id: 'wms.sku.create',
    label: '创建 SKU',
    description: '创建一个新的 SKU（库存商品）。skuCode 是全库唯一的商品编码，name 是商品名称；可选 extData 携带自定义扩展字段（如规格、保质期）。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: 'SKU 唯一编码，如 A-1001' },
        name: { type: 'string', description: '商品名称' },
        extData: { type: 'object', description: '扩展字段键值对（字段注册表声明的自定义字段）' },
      },
      required: ['skuCode', 'name'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      if (ws.skus.byCode(params.skuCode)) {
        throw new SkuAlreadyExistsError(params.skuCode);
      }
      const skuId = randomUUID();
      ctx.appendEvent(WMS_EVENT_TYPES.skuCreated, {
        skuId,
        skuCode: params.skuCode,
        name: params.name,
        extData: params.extData,
      });
      ws.sync();
      return { skuId, skuCode: params.skuCode, name: params.name };
    },
  };

  const skuUpdate: ToolDefinition<{ skuCode: string; name?: string; extData?: Record<string, unknown> }> = {
    id: 'wms.sku.update',
    label: '更新 SKU',
    description: '更新已有 SKU 的名称或扩展字段。只传需要修改的字段，未传字段保持不变。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: '要更新的 SKU 编码' },
        name: { type: 'string', description: '新的商品名称（可选）' },
        extData: { type: 'object', description: '新的扩展字段（可选，整体替换）' },
      },
      required: ['skuCode'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const sku = ws.skus.byCode(params.skuCode);
      if (!sku) throw new SkuNotFoundError(params.skuCode);
      ctx.appendEvent(WMS_EVENT_TYPES.skuUpdated, {
        skuId: sku.id,
        skuCode: sku.skuCode,
        name: params.name,
        extData: params.extData,
      });
      ws.sync();
      return { skuId: sku.id, skuCode: sku.skuCode };
    },
  };

  // ── 库位（M10）───────────────────────────────────────

  const locationCreate: ToolDefinition<{ locationCode: string; name?: string }> = {
    id: 'wms.location.create',
    label: '创建库位',
    description:
      '创建一个新的库位（仓库内的物理存储位）。locationCode 是全库唯一的库位编码（如 A-01），name 是显示名称（可选，缺省同编码）。库存可分库位存放与移库；保留字 DEFAULT 不可用于创建（它是未指定库位时库存的默认归宿，虚拟存在）。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        locationCode: { type: 'string', description: '库位唯一编码，如 A-01' },
        name: { type: 'string', description: '库位显示名称（可选，缺省同编码）' },
      },
      required: ['locationCode'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      if (typeof params.locationCode !== 'string' || !params.locationCode) {
        throw new Error('TOOL_REJECTED: locationCode 不能为空');
      }
      if (params.locationCode === DEFAULT_LOCATION_ID) {
        throw new Error('TOOL_REJECTED: DEFAULT 是保留字（默认库位，虚拟存在），不可创建同名库位');
      }
      if (ws.locations.byCode(params.locationCode)) {
        throw new LocationAlreadyExistsError(params.locationCode);
      }
      const locationId = randomUUID();
      const name = params.name ?? params.locationCode;
      ctx.appendEvent(WMS_EVENT_TYPES.locationCreated, {
        locationId,
        locationCode: params.locationCode,
        name,
      });
      ws.sync();
      return { locationId, locationCode: params.locationCode, name };
    },
  };

  const locationList: ToolDefinition<Record<string, never>> = {
    id: 'wms.location.list',
    label: '库位清单',
    description:
      '列出全部已创建的库位（编码 + 名称）。注意：还存在一个虚拟的默认库位 DEFAULT（未指定库位的库存归宿），不出现在本清单，但可在库存调整/移库/单据行中显式引用。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: (_params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      return ws.locations
        .list()
        .map((l) => ({ locationCode: l.locationCode, name: l.name, createdAt: l.createdAt }));
    },
  };

  // ── 单据 ────────────────────────────────────────────

  const orderCreate: ToolDefinition<{
    direction: OrderDirection;
    lines: {
      skuCode: string;
      quantity: number;
      locationCode?: string;
      batchNo?: string;
      batchExpiryDate?: string;
    }[];
    orderNo?: string;
    note?: string;
    /** 批次分配策略（M12 起，M13 扩加 strict，仅出库单）：strict=严格桶不分配，fifo=先进先出，fefo=先到期先出 */
    allocation?: 'strict' | 'fifo' | 'fefo';
  }> = {
    id: 'wms.order.create',
    label: '创建出入库单',
    description:
      '创建一张入库单或出库单。direction 取 in（入库）/ out（出库）；lines 是商品明细（SKU 编码 + 数量 + 可选库位编码 + 可选批次编码，数量必须是正整数）。行上的 locationCode 指定收货上架/发货扣减的库位（缺省为默认库位 DEFAULT）；batchNo 指定批次（缺省为虚拟批次 DEFAULT）：入库行声明批次并可带 batchExpiryDate 效期（YYYY-MM-DD，同批次后继必须一致），出库行指定批次则只扣该批次（不指定只扣 DEFAULT 批次，其他批次有货不救）。出库单可选 allocation 批次分配策略（strict=严格桶不分配 / fifo=先进先出 / fefo=先到期先出）：fifo/fefo 启用后未指定批次的行按策略在行库位内自动拆分为具体批次行（一行可拆多批次），显式指定批次的行不受影响；不传时用全局缺省策略（core.wms 设置 defaultAllocation，缺省 strict），本参数优先。同单同 SKU 可分不同库位/批次多行，但同 SKU 同库位同批次不可重复。orderNo 不传则自动生成。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['in', 'out'], description: '单据方向：in=入库，out=出库' },
        lines: {
          type: 'array',
          description: '单据明细行，每行 { skuCode, quantity, locationCode?, batchNo?, batchExpiryDate? }',
          items: { type: 'object' },
        },
        orderNo: { type: 'string', description: '单据号（可选，缺省自动生成）' },
        note: { type: 'string', description: '备注（可选）' },
        allocation: {
          type: 'string',
          enum: ['strict', 'fifo', 'fefo'],
          description: '批次分配策略（可选，仅出库单）：strict=严格桶（不分配，未指定批次只扣 DEFAULT），fifo=先进先出（按批次首笔入库时间），fefo=先到期先出（按效期，无期批次最后）；未传时用全局设置 settings.defaultAllocation（缺省 strict），本参数优先',
        },
      },
      required: ['direction', 'lines'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();

      // 批次分配（M12 起，M13 优先级扩展）：单参数 allocation > 全局设置
      // settings.defaultAllocation > 代码缺省 strict（readSettings 兜底后恒有值）。
      // 显式传参 + 入库单 → 拒（批次是声明不是分配）；全局策略对入库单无感
      // （不分配、不报错）。strict = 不分配（M11 严格桶：未指定批次只扣 DEFAULT）。
      if (params.allocation && params.direction !== 'out') {
        throw new Error('TOOL_REJECTED: allocation 只适用于出库单（入库行的批次是声明，不是分配）');
      }
      const settings = readSettings(ws);
      const effective =
        params.allocation ?? (params.direction === 'out' ? settings.defaultAllocation : 'strict');
      const resolvedLines =
        effective !== 'strict'
          ? expandAllocatedLines(ws, params.lines, effective, settings.blockExpiredOutbound)
          : params.lines;

      // 行级校验（schema 校验器不深入 object 内部，handler 手工补位）
      if (!Array.isArray(resolvedLines) || resolvedLines.length === 0) {
        throw new Error('TOOL_REJECTED: lines 不能为空');
      }
      const seenKeys = new Set<string>(); // 重复键 = SKU + 库位 + 批次（M11：行唯一约束四段）
      for (const [i, line] of resolvedLines.entries()) {
        if (typeof line?.skuCode !== 'string' || !line.skuCode) {
          throw new Error(`TOOL_REJECTED: 第 ${i + 1} 行缺少 skuCode`);
        }
        if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
          throw new Error(`TOOL_REJECTED: 第 ${i + 1} 行数量必须是正整数`);
        }
        const sku = ws.skus.byCode(line.skuCode);
        if (!sku) {
          throw new SkuNotFoundError(line.skuCode);
        }
        const loc = resolveLocation(ws, line.locationCode); // 库位存在性（缺省 DEFAULT）
        // 批次解析（M11）：DEFAULT 虚拟批次不携带效期；出库行不支持效期声明
        if (params.direction === 'out' && line.batchExpiryDate) {
          throw new Error(`TOOL_REJECTED: 第 ${i + 1} 行出库行不支持批次效期（效期随入库声明）`);
        }
        const batch = resolveBatch(line.batchNo, line.batchExpiryDate);
        // 新批次效期一致性 fail-fast（权威守卫在收货落流水时——建单到收货间可能有别的流水）
        if (batch.batchExpiryDate) {
          assertExpiryConsistent(ws, sku.id, sku.skuCode, batch.batchNo, batch.batchExpiryDate);
        }
        // 行唯一约束（wms_order_line 的 order+sku+location+batch 唯一，行 id 四段派生）：
        // 命令侧必须先挡，否则事件落账后投影 INSERT 炸裂、工作区永久卡死
        const key = `${line.skuCode}@${loc.locationId}@${batch.batchNo}`;
        if (seenKeys.has(key)) {
          throw new Error(
            `TOOL_REJECTED: 第 ${i + 1} 行 SKU ${line.skuCode} 在库位 ${loc.locationCode} 批次 ${batch.batchNo} 与前行重复——同单同 SKU 同库位同批次请合并数量`,
          );
        }
        seenKeys.add(key);
      }

      const orderNo = params.orderNo ?? generateOrderNo(params.direction);
      if (ws.orders.byNo(orderNo)) {
        throw new OrderAlreadyExistsError(orderNo);
      }

      const orderId = randomUUID();
      ctx.appendEvent(WMS_EVENT_TYPES.orderCreated, {
        orderId,
        orderNo,
        direction: params.direction,
        // M12：分配后行集（未启用分配时即原始行集）——事件形态与 M11 逐字节同构
        lines: resolvedLines.map((l) => {
          const batch = resolveBatch(l.batchNo, l.batchExpiryDate);
          return {
            skuId: ws.skus.byCode(l.skuCode)!.id,
            quantity: l.quantity,
            locationId: resolveLocation(ws, l.locationCode).locationId,
            batchNo: batch.batchNo,
            batchExpiryDate: batch.batchExpiryDate,
          };
        }),
        note: params.note,
      });
      ws.sync();
      return { orderId, orderNo, state: 'created' as const };
    },
  };

  const orderTransition: ToolDefinition<{ orderNo: string; to: string }> = {
    id: 'wms.order.transition',
    label: '单据状态转移',
    description:
      '推进单据状态，并自动联动库存（按行的库位 + 批次维度）：入库单进入 received 时按明细自动增加对应库位/批次库存（行声明了效期则随流水登记）；出库单进入 picking 时按行桶预检余量（不足拒绝），进入 shipped 时按行桶自动扣减库存（余量不足拒绝——注意是行指定的库位和批次的余量，不是 SKU 总量；行未指定批次则只扣 DEFAULT 批次）。合法转移由当前流程配置决定（默认：入库 created → received → done；出库 created → picking → shipped → done；未完成前可 canceled；流程配置可含更多状态）。to 是目标状态。若全局设置开启过期批次出库拦截（core.wms 的 settings.blockExpiredOutbound），出库行批次已过期（效期早于今日；今天到期视为临期可出）会被拒绝。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        orderNo: { type: 'string', description: '单据号' },
        // 不设 enum：状态词汇由流程配置定义（模块可贡献新状态），合法性由 handler 按配置裁决
        to: { type: 'string', description: '目标状态（合法值由当前流程配置决定）' },
      },
      required: ['orderNo', 'to'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const order = ws.orders.byNo(params.orderNo);
      if (!order) throw new OrderNotFoundError(params.orderNo);
      // 流程校验（M8 行为闭环）——转移表来自 Profile workflows（配置即权威）：
      // AI 慢通道改流程、模块 contributes 叠加转移，下一次流转立即生效。
      // 流程定义缺失 → 明确报错，不静默回退硬编码表（否则「删流程」的配置静默失效）。
      const workflow = ws.profile.getSnapshot().workflows[WORKFLOW_BY_DIRECTION[order.direction]];
      if (!workflow) throw new WorkflowNotFoundError(order.direction);
      assertTransition(workflow.transitions, order.direction, order.state, params.to);

      // 库存联动（M9 起，M11 升级为行库位+批次维度）：出库进入 picking 预检、进入
      // shipped 硬守卫——逐行按 (SKU, 行库位, 行批次) 验余量（行键唯一，orderCreate
      // 已挡重复行）；拒绝发生在落账前（命令失败 ≠ 事实，零事件）。入库进入
      // received 前做批次效期一致性权威校验（建单 fail-fast 之后、别的流水可能
      // 已登记了不同效期）。
      const lines = ws.orders.lines(order.id);
      const effect = stockEffectOf(order.direction, params.to);
      if (effect?.kind === 'increase') {
        for (const line of lines) {
          if (line.batchExpiryDate) {
            assertExpiryConsistent(
              ws,
              line.skuId,
              ws.skus.byId(line.skuId)?.skuCode ?? line.skuId,
              line.batchNo,
              line.batchExpiryDate,
            );
          }
        }
      }
      if (effect?.kind === 'decrease' || requiresAvailabilityCheck(order.direction, params.to)) {
        // M13 过期拦截：blockExpiredOutbound 开启时，行批次效期（以流水首个非空
        // 登记为准——出库行自身不声明效期）早于今日即拒；显式行与分配行同拦。
        // 只拦单据出库：库存调整/移库不经本守卫（盘点、报废走自己的通道）。
        const settings = readSettings(ws);
        const today = new Date().toISOString().slice(0, 10);
        for (const line of lines) {
          if (settings.blockExpiredOutbound) {
            const expiry = ws.inventory.expiryOfBatch(line.skuId, line.batchNo);
            if (isExpired(expiry, today)) {
              throw new ExpiredBatchError(
                ws.skus.byId(line.skuId)?.skuCode ?? line.skuId,
                line.batchNo,
                expiry,
              );
            }
          }
          const available = ws.inventory.quantityOf(line.skuId, line.locationId, line.batchNo);
          if (available < line.quantity) {
            throw new InsufficientStockError(
              bucketLabel(
                ws.skus.byId(line.skuId)?.skuCode ?? line.skuId,
                codeOfLocation(ws, line.locationId),
                line.batchNo,
              ),
              -line.quantity,
              available,
            );
          }
        }
      }

      // 原子落账：状态事实 + 每行流水事实同生共死（savepoint 包裹，杜绝半落账）
      const adjustedLines: { skuCode: string; locationCode: string; batchNo: string; delta: number }[] = [];
      ws.runAtomic(() => {
        ctx.appendEvent(WMS_EVENT_TYPES.orderStateChanged, {
          orderId: order.id,
          orderNo: order.orderNo,
          direction: order.direction,
          from: order.state,
          to: params.to,
        });
        if (effect) {
          for (const line of lines) {
            const skuCode = ws.skus.byId(line.skuId)?.skuCode ?? line.skuId;
            const locationCode = codeOfLocation(ws, line.locationId);
            const delta = effect.kind === 'increase' ? line.quantity : -line.quantity;
            ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
              skuId: line.skuId,
              skuCode,
              delta,
              reason: `order:${params.to}`,
              locationId: line.locationId,
              locationCode,
              batchNo: line.batchNo,
              batchExpiryDate: line.batchExpiryDate ?? undefined,
              orderId: order.id,
              orderNo: order.orderNo,
            });
            adjustedLines.push({ skuCode, locationCode, batchNo: line.batchNo, delta });
          }
        }
      });
      ws.sync();
      return {
        orderNo: order.orderNo,
        from: order.state,
        to: params.to,
        adjustedLines: adjustedLines.length > 0 ? adjustedLines : undefined,
      };
    },
  };

  // ── 库存 ────────────────────────────────────────────

  const inventoryAdjust: ToolDefinition<{
    skuCode: string;
    delta: number;
    reason?: string;
    orderNo?: string;
    locationCode?: string;
    batchNo?: string;
    batchExpiryDate?: string;
  }> = {
    id: 'wms.inventory.adjust',
    label: '库存调整',
    description:
      '对某 SKU 做库存增减：delta 为正数是入库、负数是出库。可选 locationCode 指定库位（缺省为默认库位 DEFAULT）；可选 batchNo 指定批次（缺省为虚拟批次 DEFAULT）——正数入库声明批次并可带 batchExpiryDate 效期（YYYY-MM-DD，同批次后继必须一致），负数出库只扣指定批次（不指定只扣 DEFAULT 批次，其他批次有货不救）。出库超出该库位该批次当前余量会被拒绝（库存不可为负）。可选关联单据号。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: 'SKU 编码' },
        delta: { type: 'integer', minimum: -1000000000, maximum: 1000000000, description: '数量变化：正数入库，负数出库' },
        reason: { type: 'string', description: '调整原因（可选，如 入库上架 / 盘点 / 报损）' },
        orderNo: { type: 'string', description: '关联单据号（可选）' },
        locationCode: { type: 'string', description: '库位编码（可选，缺省为默认库位 DEFAULT）' },
        batchNo: { type: 'string', description: '批次号（可选，缺省为虚拟批次 DEFAULT；批次随首条入库流水诞生）' },
        batchExpiryDate: { type: 'string', description: '批次效期 YYYY-MM-DD（可选，仅入库；同批次后继必须一致）' },
      },
      required: ['skuCode', 'delta'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const sku = ws.skus.byCode(params.skuCode);
      if (!sku) throw new SkuNotFoundError(params.skuCode);
      const loc = resolveLocation(ws, params.locationCode);
      if (params.delta === 0) {
        throw new Error('TOOL_REJECTED: delta 不能为 0');
      }
      if (params.delta < 0 && params.batchExpiryDate) {
        throw new Error('TOOL_REJECTED: 出库（负 delta）不支持批次效期——效期随入库声明');
      }
      const batch = resolveBatch(params.batchNo, params.batchExpiryDate);
      // 批次效期一致性（M11）：新批次登记 / 老批次比对（建批 fail-fast）
      assertExpiryConsistent(ws, sku.id, sku.skuCode, batch.batchNo, batch.batchExpiryDate);
      if (params.delta < 0) {
        const available = ws.inventory.quantityOf(sku.id, loc.locationId, batch.batchNo);
        if (available + params.delta < 0) {
          throw new InsufficientStockError(
            bucketLabel(sku.skuCode, loc.locationCode, batch.batchNo),
            params.delta,
            available,
          );
        }
      }
      let orderId: string | undefined;
      if (params.orderNo) {
        const order = ws.orders.byNo(params.orderNo);
        if (!order) throw new OrderNotFoundError(params.orderNo);
        orderId = order.id;
      }
      ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
        skuId: sku.id,
        skuCode: sku.skuCode,
        delta: params.delta,
        reason: params.reason ?? (params.delta > 0 ? 'inbound' : 'outbound'),
        locationId: loc.locationId,
        locationCode: loc.locationCode,
        batchNo: batch.batchNo,
        batchExpiryDate: batch.batchExpiryDate,
        orderId,
        orderNo: params.orderNo,
      });
      ws.sync();
      return {
        skuId: sku.id,
        skuCode: sku.skuCode,
        locationCode: loc.locationCode,
        batchNo: batch.batchNo,
        quantity: ws.inventory.quantityOf(sku.id, loc.locationId, batch.batchNo),
      };
    },
  };

  const inventoryMove: ToolDefinition<{
    skuCode: string;
    fromLocationCode?: string;
    toLocationCode?: string;
    quantity: number;
    batchNo?: string;
  }> = {
    id: 'wms.inventory.move',
    label: '移库',
    description:
      '把某 SKU 的库存从一个库位移到另一个库位（同批次数量转移，总量不变）。fromLocationCode / toLocationCode 缺省均为默认库位 DEFAULT；可选 batchNo 指定批次（缺省为虚拟批次 DEFAULT）——移的是该批次的货，源与目标不能相同；源库位该批次余量不足会拒绝。移库产生一对 transfer 流水（-源 / +目标），可审计。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: 'SKU 编码' },
        fromLocationCode: { type: 'string', description: '源库位编码（可选，缺省 DEFAULT）' },
        toLocationCode: { type: 'string', description: '目标库位编码（可选，缺省 DEFAULT）' },
        quantity: { type: 'integer', minimum: 1, maximum: 1000000000, description: '移库数量（正整数）' },
        batchNo: { type: 'string', description: '批次号（可选，缺省为虚拟批次 DEFAULT）' },
      },
      required: ['skuCode', 'quantity'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const sku = ws.skus.byCode(params.skuCode);
      if (!sku) throw new SkuNotFoundError(params.skuCode);
      if (!Number.isInteger(params.quantity) || params.quantity <= 0) {
        throw new Error('TOOL_REJECTED: quantity 必须是正整数');
      }
      const from = resolveLocation(ws, params.fromLocationCode);
      const to = resolveLocation(ws, params.toLocationCode);
      const batch = resolveBatch(params.batchNo, undefined); // 移库不带效期（批次属性已在入库登记）
      if (from.locationId === to.locationId) {
        throw new Error('TOOL_REJECTED: 源库位与目标库位相同');
      }
      const available = ws.inventory.quantityOf(sku.id, from.locationId, batch.batchNo);
      if (available < params.quantity) {
        throw new InsufficientStockError(
          bucketLabel(sku.skuCode, from.locationCode, batch.batchNo),
          params.quantity,
          available,
        );
      }
      // 原子落账（M9 runAtomic）：-源 / +目标 两条流水同生共死，杜绝「出旧库位
      // 了没进新库位」的半落账。零新事件类型——移库就是一对普通流水事实。
      ws.runAtomic(() => {
        ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
          skuId: sku.id,
          skuCode: sku.skuCode,
          delta: -params.quantity,
          reason: 'transfer',
          locationId: from.locationId,
          locationCode: from.locationCode,
          batchNo: batch.batchNo,
        });
        ctx.appendEvent(WMS_EVENT_TYPES.inventoryAdjusted, {
          skuId: sku.id,
          skuCode: sku.skuCode,
          delta: params.quantity,
          reason: 'transfer',
          locationId: to.locationId,
          locationCode: to.locationCode,
          batchNo: batch.batchNo,
        });
      });
      ws.sync();
      return {
        skuCode: sku.skuCode,
        from: from.locationCode,
        to: to.locationCode,
        batchNo: batch.batchNo,
        quantity: params.quantity,
        fromBalance: ws.inventory.quantityOf(sku.id, from.locationId, batch.batchNo),
        toBalance: ws.inventory.quantityOf(sku.id, to.locationId, batch.batchNo),
      };
    },
  };

  const inventoryQuery: ToolDefinition<{ skuCode?: string; locationCode?: string }> = {
    id: 'wms.inventory.query',
    label: '查询库存',
    description:
      '查询库存余量（按 SKU 汇总，可下钻库位与批次明细）。给 skuCode 查单个 SKU（返回 total 总量与 byLocation 分库位明细，库位内再列 batches 批次明细）；都不给列出全部 SKU 的分组清单；给 locationCode 查该库位内有哪些货（平铺行，含批次号与效期）。库位 DEFAULT 是默认库位、批次 DEFAULT 是虚拟批次（未指定维度的库存归宿）。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: 'SKU 编码（可选，缺省查全部）' },
        locationCode: { type: 'string', description: '库位编码（可选，给定时返回该库位的平铺清单）' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const loc = resolveLocation(ws, params.locationCode); // 库位存在性校验（含 DEFAULT 直通）
      const nameOf = (locationId: string): string =>
        locationId === DEFAULT_LOCATION_ID
          ? '默认库位'
          : (ws.locations.byId(locationId)?.name ?? '(未知库位)');

      // 形态一：按库位平铺——「这个库位里有什么」（行含批次与效期）
      if (params.locationCode) {
        let rows = ws.inventory.list().filter((r) => r.locationId === loc.locationId);
        if (params.skuCode) {
          const sku = ws.skus.byCode(params.skuCode);
          if (!sku) throw new SkuNotFoundError(params.skuCode);
          rows = rows.filter((r) => r.skuId === sku.id);
        }
        return rows.map((r) => {
          const sku = ws.skus.byId(r.skuId);
          return {
            skuId: r.skuId,
            skuCode: sku?.skuCode ?? '(已删除)',
            name: sku?.name ?? '',
            locationCode: loc.locationCode,
            locationName: nameOf(loc.locationId),
            batchNo: r.batchNo,
            batchExpiryDate: r.batchExpiryDate,
            quantity: r.quantity,
          };
        });
      }

      // 形态二：按 SKU 分组——total 总量 + byLocation 分库位明细（内嵌 batches 批次明细）
      const groupOf = (skuId: string) => {
        const sku = ws.skus.byId(skuId);
        const rows = ws.inventory.list().filter((r) => r.skuId === skuId);
        // 库位聚合（批次维度行 → 库位行），库位内保留批次明细
        const byLoc = new Map<
          string,
          { quantity: number; batches: { batchNo: string; batchExpiryDate: string | null; quantity: number }[] }
        >();
        for (const r of rows) {
          const cur = byLoc.get(r.locationId) ?? { quantity: 0, batches: [] };
          cur.quantity += r.quantity;
          cur.batches.push({
            batchNo: r.batchNo,
            batchExpiryDate: r.batchExpiryDate,
            quantity: r.quantity,
          });
          byLoc.set(r.locationId, cur);
        }
        return {
          skuId,
          skuCode: sku?.skuCode ?? '(已删除)',
          name: sku?.name ?? '',
          total: rows.reduce((a, r) => a + r.quantity, 0),
          byLocation: [...byLoc.entries()].map(([locationId, l]) => ({
            locationCode: codeOfLocation(ws, locationId),
            locationName: nameOf(locationId),
            quantity: l.quantity,
            batches: l.batches.sort((a, b) => a.batchNo.localeCompare(b.batchNo)),
          })),
        };
      };
      if (params.skuCode) {
        const sku = ws.skus.byCode(params.skuCode);
        if (!sku) throw new SkuNotFoundError(params.skuCode);
        return groupOf(sku.id); // 无库存 → { total: 0, byLocation: [] }
      }
      return ws.inventory
        .list()
        .map((r) => r.skuId)
        .filter((id, i, arr) => arr.indexOf(id) === i)
        .map(groupOf)
        .sort((a, b) => a.skuCode.localeCompare(b.skuCode));
    },
  };

  const inventoryExpiring: ToolDefinition<{ days?: number }> = {
    id: 'wms.inventory.expiring',
    label: '临期查询',
    description:
      '查询临期/过期的批次库存：列出效期在 N 天内（含已过期）的批次余量——SKU、库位、批次号、效期、剩余天数、数量，按效期升序（最先到期的排前面）。days 缺省 30。未指定批次的库存（虚拟批次 DEFAULT）无效期，不出现在结果中；未声明效期的真批次同样不出现在结果中。出库遇过期批次 v1 不拦截，本工具用于临期可见性（提醒先进先出）。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 0, maximum: 3650, description: '临期阈值天数（缺省 30，含已过期）' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const days = params.days ?? 30;
      if (!Number.isInteger(days) || days < 0) {
        throw new Error('TOOL_REJECTED: days 必须是非负整数');
      }
      const today = new Date().toISOString().slice(0, 10); // UTC 日期（与自动单号同源）
      const nameOf = (locationId: string): string =>
        locationId === DEFAULT_LOCATION_ID
          ? '默认库位'
          : (ws.locations.byId(locationId)?.name ?? '(未知库位)');
      return ws.inventory.listExpiring(days, today).map((r) => {
        const sku = ws.skus.byId(r.skuId);
        return {
          skuId: r.skuId,
          skuCode: sku?.skuCode ?? '(已删除)',
          name: sku?.name ?? '',
          locationCode: codeOfLocation(ws, r.locationId),
          locationName: nameOf(r.locationId),
          batchNo: r.batchNo,
          batchExpiryDate: r.batchExpiryDate,
          daysLeft: Math.round((Date.parse(r.batchExpiryDate!) - Date.parse(today)) / 86400000),
          quantity: r.quantity,
        };
      });
    },
  };

  return [
    def(skuCreate),
    def(skuUpdate),
    def(locationCreate),
    def(locationList),
    def(orderCreate),
    def(orderTransition),
    def(inventoryAdjust),
    def(inventoryMove),
    def(inventoryQuery),
    def(inventoryExpiring),
  ];
}

/** 自动单号：IN-20261030-a1b2c3d4（方向 + 日期 + uuid 片段） */
function generateOrderNo(direction: OrderDirection): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${direction === 'in' ? 'IN' : 'OUT'}-${date}-${randomUUID().slice(0, 8)}`;
}
