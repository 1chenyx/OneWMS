import type { ToolDefinition } from '@one/core';
import { listSerials, querySerial } from '../queries/serial-queries.js';
import { def, type WorkspaceResolver } from './tool-def.js';

/**
 * 序列号查询（module.serial）。
 * 号本身在调整、收货、发货时诞生，这里只查。
 * 工具不进 core.wms 的 tools 数组。
 */
export function createSerialTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const serialList: ToolDefinition<{ skuCode?: string; locationCode?: string; status?: string }> = {
    id: 'wms.serial.list',
    label: '查序列号',
    description:
      '列出序列号。skuCode、locationCode 可选。status 缺省 in（在库）；out 只看已出库；all 两边都看。有托盘时带 lpnCode。停用 module.serial 后本工具拒绝。纯读，不产生事件。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        skuCode: { type: 'string', description: 'SKU 编码（可选）' },
        locationCode: { type: 'string', description: '库位编码（可选）' },
        status: { type: 'string', description: 'in / out / all，缺省 in' },
      },
      required: [],
    },
    handler: (params, ctx) =>
      listSerials(resolveWorkspace(ctx.workspaceId), {
        skuCode: params.skuCode,
        locationCode: params.locationCode,
        status: params.status,
      }),
  };

  const serialQuery: ToolDefinition<{ serialNo: string }> = {
    id: 'wms.serial.query',
    label: '查序列号',
    description:
      '按序列号查一件货现在在哪、属于哪个 SKU、是否已出库、装在哪个托盘。号不存在会报错。停用 module.serial 后本工具拒绝。纯读，不产生事件。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        serialNo: { type: 'string', description: '序列号' },
      },
      required: ['serialNo'],
    },
    handler: (params, ctx) => querySerial(resolveWorkspace(ctx.workspaceId), params.serialNo ?? ''),
  };

  return [def(serialList), def(serialQuery)];
}
