import type { WmsWorkspace } from '@one/wms';
import { AI_BEHAVIOR_RULES, AI_IDENTITY, MAX_SKU_ROWS } from './prompts.js';

/**
 * System Prompt 组装（DESIGN.md §6.4 消费闭环 ② 的 v2，里程碑 4）。
 *
 * 段落结构：身份与行为规则（含慢通道规则）→ 当前配置（Profile 摘要）→
 * 库存快照 → 时间。静态文案集中管理在 prompts.ts（统一优化入口），
 * 本文件只负责把规则文案与运行时数据拼装。
 * 工具清单走 function calling 的 tools 参数（原生通道，
 * 不在 prompt 文本里重复）。
 *
 * Profile 摘要 = §6.4 闭环 ②：可见扩展字段、流程概要、模块开关——
 * 模型据此生成合法的配置 patch（字段键名、流程结构都来自这段上下文）。
 * 每次任务组装一次——快照新鲜度以任务为粒度。
 */


export function buildSystemPrompt(ws: WmsWorkspace): string {
  const skus = ws.skus.list();
  // 库存按 SKU 聚合（M10：list() 是 SKU×库位 维度行，同 SKU 多行必须求和——
  // 此前 Map 直装会在多库位时静默丢桶）
  const inventory = ws.inventory
    .list()
    .reduce((m, r) => m.set(r.skuId, (m.get(r.skuId) ?? 0) + r.quantity), new Map<string, number>());
  const rows = skus
    .map((s) => ({ skuCode: s.skuCode, name: s.name, quantity: inventory.get(s.id) ?? 0 }))
    .sort((a, b) => a.skuCode.localeCompare(b.skuCode));
  const totalQuantity = [...inventory.values()].reduce((a, b) => a + b, 0);
  const locations = ws.locations.list();

  const lines: string[] = [AI_IDENTITY, '', '行为规则：'];
  AI_BEHAVIOR_RULES.forEach((rule, i) => lines.push(`${i + 1}. ${rule}`));

  // ── Profile 摘要（§6.4 闭环 ②）──────────────────────
  const profile = ws.profile.getSnapshot();
  lines.push('', '当前配置（Profile）：');

  const fieldEntries = Object.entries(profile.schema.entities)
    .flatMap(([entity, def]) =>
      def.extensions.map((f) => ({ entity, ...f })),
    )
    .sort((a, b) => `${a.entity}.${a.key}`.localeCompare(`${b.entity}.${b.key}`));
  if (fieldEntries.length === 0) {
    lines.push('- 扩展字段：无');
  } else {
    lines.push(`- 扩展字段（${fieldEntries.length} 个，格式 实体.键（名称））：`);
    for (const f of fieldEntries) {
      lines.push(`  ${f.entity}.${f.key}（${f.label}${f.visible ? '' : '，当前已隐藏'}）`);
    }
  }

  const workflowIds = Object.keys(profile.workflows);
  if (workflowIds.length === 0) {
    lines.push('- 流程：无');
  } else {
    for (const wfId of workflowIds) {
      const wf = profile.workflows[wfId];
      const chain = wf.states.map((s) => s.label).join(' → ');
      lines.push(`- 流程 ${wfId}：${chain}（状态 ${wf.states.length} 个，转移 ${wf.transitions.length} 条）`);
    }
  }

  const moduleIds = Object.keys(profile.modules);
  if (moduleIds.length === 0) {
    lines.push('- 模块：无');
  } else {
    for (const modId of moduleIds) {
      lines.push(`- 模块 ${modId}：${profile.modules[modId].enabled ? '已启用' : '已停用'}`);
    }
  }

  // ── 库存快照 ─────────────────────────────────────────
  lines.push(
    '',
    '当前库存快照：',
    `- SKU 总数：${skus.length}；有库存记录的 SKU：${inventory.size}；库存总量：${totalQuantity}`,
  );
  // 库位上下文（M10）：快照给全局量，分库位明细引导用查询工具
  if (locations.length > 0) {
    lines.push(
      `- 库位：${locations.length} 个（${locations.map((l) => l.locationCode).join('、')}）；另有默认库位 DEFAULT 收容未指定库位的库存。分库位余量用库存查询工具获取`,
    );
  }
  // 批次上下文（M11）：效期管理引导——临期可见性用临期查询工具；
  // M12 补充：出库单可用 allocation 批次分配策略；M13 补充：全局缺省策略与
  // 过期出库拦截是 core.wms 模块设置（settings），改值走慢通道提案
  lines.push(
    `- 批次：库存按 SKU×库位×批次分桶，未指定批次的库存归虚拟批次 DEFAULT。入库可声明批次与效期（YYYY-MM-DD），出库可指定批次扣减（不指定只扣 DEFAULT 批次）。临期/过期批次用临期查询工具（wms.inventory.expiring）获取。出库单创建时可传 allocation 策略（strict 严格桶 / fifo 先进先出 / fefo 先到期先出），未指定批次的行按策略在行库位内自动分配批次；全局缺省策略（defaultAllocation）与过期批次出库拦截（blockExpiredOutbound）是 core.wms 模块设置，修改走配置慢通道（propose → confirm）`,
  );

  if (rows.length > 0) {
    lines.push(`- SKU 明细（前 ${Math.min(rows.length, MAX_SKU_ROWS)} 条，格式：编码 / 名称 / 库存）：`);
    for (const r of rows.slice(0, MAX_SKU_ROWS)) {
      lines.push(`  ${r.skuCode} / ${r.name} / ${r.quantity}`);
    }
    if (rows.length > MAX_SKU_ROWS) {
      lines.push(`  （仅列前 ${MAX_SKU_ROWS} 条，其余请用库存查询工具获取）`);
    }
  } else {
    lines.push('- 暂无 SKU。用户要出入库时先用创建 SKU 工具建档。');
  }

  lines.push('', `当前时间：${new Date().toISOString()}`);
  return lines.join('\n');
}
