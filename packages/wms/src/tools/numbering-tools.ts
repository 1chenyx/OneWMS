import type { ToolDefinition } from '@one/core';
import { describeNumbering, previewCandidate } from '../numbering/allocate.js';
import { def, type WorkspaceResolver } from './tool-def.js';

/**
 * 编号预览。只读，不写配置。
 * 改规则仍走 profile.propose → 人工确认。返回的 patchOp / path / numbering 就是那次提议的材料。
 */
export function createNumberingTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const preview: ToolDefinition<{ place?: string; pattern?: string }> = {
    id: 'wms.numbering.preview',
    label: '预览编号',
    description:
      '预览各处下一编号，或试算一条还没保存的模板。不传 place 返回全部位置：入库单 order.in、出库单 order.out、到货预报 order.asn、客退 order.return.in、退供 order.return.out、拣货单 picking、盘点单 stocktake、商品 sku、供应商 partner.supplier、客户 partner.customer、库位 location、仓库 warehouse、托盘 lpn。每个位置含当前模板、怎么重新计数、下一号。传 pattern 时必须同时传 place，按这条还没保存的模板试算下一号，不写配置。返回的 patchOp、path、numbering 给 profile.propose 用：value 用 numbering 整对象，只改用户点名的位置，其余保持返回值。确认前规则不变。模板必须有且只有一个序号，记号是 {yyyy} {yy} {MM} {dd} {yyyyMMdd} {seq} {seq:位数}。写了日就每天重新计数，只写到月就每月，只写年就每年，都不写就一直累加。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        place: {
          type: 'string',
          description: '编号位置，如 order.in 或 sku。不传则返回全部位置',
        },
        pattern: {
          type: 'string',
          description: '试算用的模板，如 IN-{yyyyMMdd}-{seq:4}。只预览，不保存。必须和 place 一起用',
        },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const place = typeof params.place === 'string' ? params.place.trim() : '';
      const pattern = typeof params.pattern === 'string' ? params.pattern : undefined;
      if (pattern !== undefined) {
        if (!place) throw new Error('TOOL_REJECTED: 试算模板时要带上 place');
        return previewCandidate(ws, place, pattern);
      }
      return describeNumbering(ws, place || undefined);
    },
  };
  return [def(preview)];
}
