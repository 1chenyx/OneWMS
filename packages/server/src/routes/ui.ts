import { Hono } from 'hono';
import type { ManifestRecord, ManifestUiPage } from '@one/core';
import type { AppContext } from '../context.js';

/**
 * SDUI 页面清单端点（B.6）：GET /api/ui/pages —— 「服务端描述界面」的下发口。
 *
 * 为什么单独开端点而不扩 /api/profile/catalog：catalog 是给流程页用的薄目录
 * （名字/说明/流程贡献），而页面清单要**内联实体的列定义**——前端一个请求
 * 就能把导航项、表格列、表单控件、读写工具 id 全部拼出来，不用先查页面再查实体。
 * 两份数据的消费方与时机都不同，混在一个响应里只会让两边都变胖。
 *
 * 白名单纪律（与 /api/dyn 同源，别放宽）：
 *  - 只收「已安装且 enabled」模块的 manifest.ui.pages——停用模块的页面不该出现在导航里；
 *  - 页面的 record 必须能在 `modules.dynRecords()`（= 生效 manifest ∩ 已安装，
 *    /api/dyn 用的同一个白名单）里解析到，解析不到就**整页跳过**而不是发个空壳：
 *    ⚠️ 发空壳等于给前端一条「点开就 404」的死链，而 404 只有运行时才看得见。
 *
 * 内联的列定义直接取自 dynRecords() 的 record，不另抄 manifest.records——
 * 两者本是同一份数据，但只有前者保证与 /api/dyn 实际接受的列完全一致。
 */
export function uiRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get('/pages', (c) => c.json({ pages: collectPages(ctx) }));

  return app;
}

/** 一个页面 + 它渲染的实体（含列定义与读写工具 id） */
interface UiPagePayload {
  id: string;
  label: string;
  kind: string;
  description?: string;
  /** 前端导航大类（前端白名单映射，未知归「档案」） */
  category?: string;
  /** 图标名（前端白名单映射 antd 图标，未知用默认图标） */
  icon?: string;
  moduleId: string;
  moduleName: string;
  record: {
    id: string;
    label: string;
    /** /api/dyn/:module/:type 的 :module */
    module: string;
    /** /api/dyn/:module/:type 的 :type */
    type: string;
    note?: string;
    fields: {
      key: string;
      label: string;
      type?: string;
      queryable: boolean;
      description?: string;
    }[];
    /** 读写都走 B.5 的 /api/tools/:toolId/invoke（write 会回令牌，需二次 confirm） */
    tools: { list: string; get: string; create: string; update: string; delete: string };
  };
}

function collectPages(ctx: AppContext): UiPagePayload[] {
  const schemas = ctx.ws.modules.dynRecords();
  const pages: UiPagePayload[] = [];
  for (const installed of ctx.ws.modules.listInstalled()) {
    if (!installed.enabled) continue;
    for (const page of installed.manifest?.ui?.pages ?? []) {
      const payload = toPayload(page, installed.id, installed.manifest?.name, schemas);
      if (payload) pages.push(payload);
    }
  }
  return pages;
}

function toPayload(
  page: ManifestUiPage,
  moduleId: string,
  moduleName: string | undefined,
  schemas: { moduleId: string; record: ManifestRecord }[],
): UiPagePayload | null {
  // v1 只有 record-list 一种形态；未知 kind 前端只能整页兜底，索性不下发
  if (page?.kind !== 'record-list' || typeof page?.record !== 'string') return null;
  const schema = schemas.find((s) => s.moduleId === moduleId && s.record.id === page.record);
  if (!schema) return null;
  const record = schema.record;
  return {
    id: page.id,
    label: page.label,
    kind: page.kind,
    ...(page.description ? { description: page.description } : {}),
    ...(page.category ? { category: page.category } : {}),
    ...(page.icon ? { icon: page.icon } : {}),
    moduleId,
    moduleName: moduleName ?? moduleId,
    record: {
      id: record.id,
      label: record.label,
      module: moduleId,
      // 实体 id 形态固定为 `dyn.{moduleId}.{type}`，而 type 的词法不允许点号
      // （core 的 RECORD_ID_RE 保证），所以最后一个点之后就是 :type——
      // 不用拼前缀字符串去 slice：拼错一个字符就静默截出半截 type，而这种错不会报错。
      type: record.id.slice(record.id.lastIndexOf('.') + 1),
      ...(record.note ? { note: record.note } : {}),
      fields: record.fields.map((f) => ({
        key: f.key,
        label: f.label,
        ...(f.type ? { type: f.type } : {}),
        queryable: f.queryable === true,
        ...(f.description ? { description: f.description } : {}),
      })),
      tools: {
        list: `${record.id}.list`,
        get: `${record.id}.get`,
        create: `${record.id}.create`,
        update: `${record.id}.update`,
        delete: `${record.id}.delete`,
      },
    },
  };
}
