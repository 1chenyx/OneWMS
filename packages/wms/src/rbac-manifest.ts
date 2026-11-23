import type { ModuleManifest } from '@one/core';

/**
 * module.rbac —— 用户与角色（见 docs/ROADMAP.md §3.4）。
 *
 * 模式门控：代码里的连接模式只有 lan / platform（没有 local），
 * 所以「本地单人不需要账号」落地为**装但默认停用**——wms.ts 用 #installOptIn
 * 装上后立刻经慢通道把 enabled 置 false。单人作业时导航不显示用户页、
 * 接口不拦登录；要用多人时到模块页打开它（慢通道确认）。
 * 不依赖任何业务模块（core 的 oplog 元数据扩展另算），不用 dependencies 表达。
 *
 * 实现落在宿主层（packages/server/src/rbac/）：用户/角色/会话存储、
 * scrypt 口令散列、鉴权中间件、四类权限对象判定、/api/auth/* 路由。
 * 账号散列不进 oplog——那是会同步到别的节点、还会被 AI 读到的事实流。
 */
export function rbacManifest(): ModuleManifest {
  return {
    id: 'module.rbac',
    name: '用户与角色',
    description:
      '多人作业的账号与权限。默认停用：一个人在这台机器上干活不需要账号，免登录直接用。局域网或平台模式下多人共用时才打开它。启用后，现场每个人有自己的账号和角色：仓库经理全权并负责配置确认，仓管员管单据和库存，库工只做场景作业和查询，审计只读含操作日志。角色可自定义，权限按页面、工具读写、配置确认、报表导出四类授予。第一次启用会让你建第一个仓库经理账号，之后由他建别人。出库单和拣货批次可以指派到人，工作台按人过滤待办，谁做的每一步记进操作日志。停用本模块后回到免登录单人模式（局域网模式下停用会要求二次确认），用户和角色档案保留不删。',
    version: '0.1.0',
    capabilities: ['db.read', 'events.subscribe'],
    aliases: ['账号', '权限', '用户'],
    records: [
      {
        id: 'user',
        label: '用户',
        aliases: ['账号'],
        note: '模块停用（默认）时免登录，没有用户概念。这些是固定列，不能增删。',
        fields: [
          { key: 'username', label: '账号', description: '登录名，全库唯一' },
          { key: 'displayName', label: '显示名' },
          { key: 'role', label: '角色', description: '可自定义；内置种子：仓库经理 / 仓管员 / 库工 / 审计' },
          { key: 'node', label: '所属节点', description: '局域网 / 平台模式下该用户主要作业的节点' },
          { key: 'status', label: '状态', description: '启用或停用。停用后不能登录，历史记录保留' },
        ],
      },
    ],
    settings: {
      schema: {
        type: 'object',
        properties: {
          sessionTimeoutMinutes: {
            type: 'integer',
            minimum: 5,
            description:
              '登录会话多久不动算过期（分钟），过期后要重新登录。现场交接班场景建议短一些。改这一项走 profile.propose，路径 /modules/module.rbac/settings/sessionTimeoutMinutes',
            default: 240,
          },
          assignOnCreate: {
            type: 'boolean',
            description:
              '出库单创建时是否自动指派给创建人，工作台随即按人过滤待办。关着则指派完全手动。只影响指派，不影响权限',
            default: false,
          },
        },
      },
    },
  };
}
