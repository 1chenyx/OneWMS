import type { ProfileFieldType, UiPageKind } from '@one/core';
import { request } from './request';
import type { ListPage } from './page';

/**
 * SDUI 运行时接口（B.6）：页面清单 + 通用记录读写 + 写操作确认。
 *
 * 三件事放一个文件是因为它们是同一条链路——前端拿到页面描述后，
 * 读走 /api/dyn、写走 /api/tools，拆成三个文件只会让「这个页面的数据从哪来」
 * 变成跨文件追踪。既有的 wms-api / profile-api 都是「一个业务域一个文件」，这里同理。
 */

/** 页面清单里内联的一列（源自 manifest 的固定列声明） */
export interface UiPageField {
  key: string;
  label: string;
  /** 列类型；缺省 = manifest 没写，按 string 渲染 */
  type?: ProfileFieldType;
  /** 能不能当过滤条件（服务端白名单：没标 queryable 的列拿去过滤直接 404） */
  queryable: boolean;
  description?: string;
}

/** 页面渲染的实体：路径参数（module/type）+ 读写工具 id 都由服务端给出，前端不自己拼 */
export interface UiPageRecord {
  id: string;
  label: string;
  /** /api/dyn/:module/:type 的 :module */
  module: string;
  /** /api/dyn/:module/:type 的 :type */
  type: string;
  note?: string;
  fields: UiPageField[];
  tools: { list: string; get: string; create: string; update: string; delete: string };
}

/** 一个页面的完整描述（导航项、表格列、表单控件、写操作全从这里拼） */
export interface UiPageDescriptor {
  /** 页面 key，即 app-nav 的 Page（形态 ui.{moduleId}.{pageId}） */
  id: string;
  label: string;
  kind: UiPageKind;
  description?: string;
  /** 导航大类名；前端白名单映射，未知归「档案」（见 nav.ts） */
  category?: string;
  /** 图标名；前端白名单映射 antd 图标，未知用默认图标（见 nav.ts） */
  icon?: string;
  moduleId: string;
  moduleName: string;
  record: UiPageRecord;
}

/** /api/dyn 清单里的一行（data 是列值袋，version 供乐观并发） */
export interface DynRow {
  recordId: string;
  data: Record<string, unknown>;
  version: number;
}

/** 清单查询条件（全部服务端执行；filter 只认 queryable 的列） */
export interface DynListQuery {
  limit?: number;
  offset?: number;
  filter?: string;
  equals?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
}

/** B.5 确认闸口的「待确认」响应：只发令牌，服务端什么都没写 */
export interface ToolInvokePending {
  pending: true;
  token: string;
  expiresAt: string;
  toolId: string;
  label: string;
  permission: 'read' | 'write';
  params: Record<string, unknown>;
}

/** 「已执行」响应：read 直通、write 带令牌确认成功后都是这个形状 */
export interface ToolInvokeDone {
  pending: false;
  toolId: string;
  label: string;
  result: unknown;
}

export type ToolInvokeResult = ToolInvokePending | ToolInvokeDone;

/** 页面清单（服务端把页面描述 + 内联列定义一次组装好） */
function uiPages(): Promise<{ pages: UiPageDescriptor[] }> {
  return request<{ pages: UiPageDescriptor[] }>('/api/ui/pages');
}

/** 通用记录清单 */
function dynRecords(module: string, type: string, query?: DynListQuery): Promise<ListPage<DynRow>> {
  const params = new URLSearchParams();
  if (query?.limit) params.set('limit', String(query.limit));
  if (query?.offset) params.set('offset', String(query.offset));
  // filter 与 equals 成对：只给字段不给值等于没过滤（服务端会 400）
  if (query?.filter && query?.equals) {
    params.set('filter', query.filter);
    params.set('equals', query.equals);
  }
  const qs = params.toString();
  const base = `/api/dyn/${encodeURIComponent(module)}/${encodeURIComponent(type)}`;
  return request<ListPage<DynRow>>(qs ? `${base}?${qs}` : base);
}

/** 申请调用工具：read 直接回结果，write 回待确认令牌（202，此刻尚未落地） */
function invokeTool(toolId: string, params: Record<string, unknown>): Promise<ToolInvokeResult> {
  return request<ToolInvokeResult>(`/api/tools/${encodeURIComponent(toolId)}/invoke`, {
    method: 'POST',
    body: JSON.stringify({ params }),
  });
}

/** 带令牌落地（令牌失效 → 409，重新申请即可） */
function confirmTool(toolId: string, token: string): Promise<ToolInvokeResult> {
  return request<ToolInvokeResult>(`/api/tools/${encodeURIComponent(toolId)}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

export const uiApi = { uiPages, dynRecords, invokeTool, confirmTool };
