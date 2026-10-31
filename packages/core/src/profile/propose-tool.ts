import type { ToolDefinition } from '../bus/tool-bus.js';
import type { PatchOp } from './profile-types.js';
import type { ProfileService } from './profile-service.js';

/**
 * profile.propose —— AI 慢通道的唯一入口（DESIGN.md §4.1 配置层通道）。
 *
 * 边界（宪法级，措辞刻进 description 让模型看得见）：
 *  - 本工具只产生**待确认提议**并返回影响报告——配置不会被修改；
 *  - confirm/reject 永远不注册为工具：人工确认权不可委托给 AI（§4.1）；
 *  - 隐藏字段用 replace visible:false，禁止 remove（数据永不丢失）。
 *
 * 参数 schema 走总线粗校验（array of object），细校验在校验管线（错误清单
 * 会以 ProfileValidationError 回传模型，由它向用户解释——错误回传不中断）。
 */
export function createProfileProposeTool(service: ProfileService): ToolDefinition {
  return {
    id: 'profile.propose',
    label: '提议配置变更',
    description:
      '提交一份 JSON Patch（RFC 6902 子集：add/replace/remove）提议修改系统配置。' +
      '允许的路径根：/schema（字段）、/workflows（流程）、/modules（模块设置）。' +
      '规则：隐藏字段用 replace 把 visible 改为 false（禁止 remove，数据永不删除）；' +
      '新增字段用 add 到 /schema/entities/{实体}/extensions/-，value 含 key/label/type/providedBy；' +
      '流程的 when 条件只允许 module.{id}.enabled 或其否定。' +
      '本工具只生成待确认提议并返回影响报告——必须把报告内容如实转述给用户，等待用户亲自确认后配置才会生效；你无权代替用户确认，也不要声称已应用。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        patch: {
          type: 'array',
          description: 'JSON Patch 操作数组，每项 { op, path, value }',
          items: { type: 'object' },
        },
        note: {
          type: 'string',
          description: '一句话说明这次配置变更的意图（会显示在确认界面）',
        },
      },
      required: ['patch'],
    },
    handler: (params, ctx) => {
      const { patch, note } = params as { patch: PatchOp[]; note?: string };
      const { proposalId, report } = service.propose(ctx.workspaceId, ctx.actor, patch, note);
      return {
        proposalId,
        report,
        pendingConfirm: true,
        hint: '提议已生成，等待用户确认。请将上述影响报告如实转述给用户。',
      };
    },
  };
}
