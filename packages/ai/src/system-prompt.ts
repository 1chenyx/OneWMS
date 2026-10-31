import type { WmsWorkspace } from '@one/wms';

/**
 * System Prompt 组装（DESIGN.md §6.4 消费闭环 ② 的 v2，里程碑 4）。
 *
 * 段落结构：身份与行为规则（含慢通道规则）→ 当前配置（Profile 摘要）→
 * 库存快照 → 时间。工具清单走 function calling 的 tools 参数（原生通道，
 * 不在 prompt 文本里重复）。
 *
 * Profile 摘要 = §6.4 闭环 ②：可见扩展字段、流程概要、模块开关——
 * 模型据此生成合法的配置 patch（字段键名、流程结构都来自这段上下文）。
 * 每次任务组装一次——快照新鲜度以任务为粒度。
 */

/** 快照中最多列出的 SKU 明细条数（控制 token；超出的引导模型用查询工具） */
const MAX_SKU_ROWS = 20;

export function buildSystemPrompt(ws: WmsWorkspace): string {
  const skus = ws.skus.list();
  const inventory = new Map(ws.inventory.list().map((r) => [r.skuId, r.quantity]));
  const rows = skus
    .map((s) => ({ skuCode: s.skuCode, name: s.name, quantity: inventory.get(s.id) ?? 0 }))
    .sort((a, b) => a.skuCode.localeCompare(b.skuCode));
  const totalQuantity = [...inventory.values()].reduce((a, b) => a + b, 0);

  const lines: string[] = [
    '你是 OneWMS 仓库管理系统的助手，帮用户用自然语言完成出入库和查询。',
    '',
    '行为规则：',
    '1. 对业务数据的任何读写都必须通过工具调用完成，不要凭空编造数据。',
    '2. 工具返回 error 时，如实向用户转述原因（如库存不足、编码重复），不要重试超过一次，更不要虚构成功。',
    '3. 操作完成后用简洁的中文汇报结果（涉及数量、编码、单号时给出具体值）。',
    '4. 用户想修改配置（隐藏/恢复字段、调整流程、改模块设置）时，用 profile.propose 工具提交 JSON Patch 提议；',
    '   把返回的影响报告如实转述给用户，等用户亲自确认后配置才会生效——你无权代替用户确认，也不要声称已应用。',
    '5. 隐藏字段用 replace 把 visible 改为 false（禁止 remove）；新增字段用 add 到 /schema/entities/{实体}/extensions/-。',
  ];

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
