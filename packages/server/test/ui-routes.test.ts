import { describe, it, expect, afterEach } from 'vitest';
import type { ModuleManifest } from '@one/core';
import { createApp, createAppContext, type AppContext } from '../src/index.js';

/**
 * B.6 SDUI 页面清单端点直测。核心契约：
 *  - 只下发「已安装且 enabled」模块声明的页面——停用/卸载的模块不能留死链在导航里；
 *  - 页面**内联**实体的列定义与读写工具 id，前端一个请求就能拼出表格、表单与写操作；
 *  - module/type 拆解与 /api/dyn 的路径参数严格对齐（两处错位 = 页面打得开但读不到数据）；
 *  - 可选字段缺省时不出现在 JSON 里（不给前端塞 undefined 键，免得 `in` 判断失真）。
 */

let ctx: AppContext | undefined;
afterEach(() => {
  ctx?.close();
  ctx = undefined;
});

const MODULE = 'vendor.asset';
const TYPE = 'device';
const RECORD = `dyn.${MODULE}.${TYPE}`;
const PAGE = `ui.${MODULE}.devices`;

function manifest(overrides: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    id: MODULE,
    name: '设备台账',
    description: '纯 JSON 声明的资产管理模块',
    version: '1.0.0',
    capabilities: ['db.read', 'db.write'],
    records: [
      {
        id: RECORD,
        label: '设备',
        note: '列结构由 manifest 定义',
        fields: [
          { key: 'name', label: '设备名', type: 'string', queryable: true, description: '唯一名称' },
          { key: 'count', label: '数量', type: 'number' },
        ],
      },
    ],
    ui: {
      pages: [
        {
          id: PAGE,
          label: '设备台账',
          kind: 'record-list',
          record: RECORD,
          category: 'registry',
          icon: 'DatabaseOutlined',
          description: '设备清单',
        },
      ],
    },
    ...overrides,
  };
}

function setup(opts: { install?: boolean } = {}): ReturnType<typeof createApp> {
  ctx = createAppContext({ dbPath: ':memory:', workspaceId: 'ws-ui-routes-test' });
  if (opts.install !== false) ctx.ws.modules.install(manifest());
  return createApp(ctx);
}

interface UiPage {
  id: string;
  label: string;
  kind: string;
  description?: string;
  category?: string;
  icon?: string;
  moduleId: string;
  moduleName: string;
  record: {
    id: string;
    label: string;
    module: string;
    type: string;
    note?: string;
    fields: Array<{ key: string; label: string; type?: string; queryable: boolean; description?: string }>;
    tools: Record<string, string>;
  };
}

async function pages(app: ReturnType<typeof createApp>): Promise<UiPage[]> {
  const res = await app.request('/api/ui/pages');
  expect(res.status).toBe(200);
  return ((await res.json()) as { pages: UiPage[] }).pages;
}

describe('GET /api/ui/pages', () => {
  it('没有声明式模块时返回空清单（不是 404，也不是 null）', async () => {
    expect(await pages(setup({ install: false }))).toEqual([]);
  });

  it('下发页面并内联列定义；module/type 与 /api/dyn 路径参数对齐', async () => {
    const app = setup();
    const list = await pages(app);
    expect(list).toHaveLength(1);
    const page = list[0];
    expect(page.id).toBe(PAGE);
    expect(page.kind).toBe('record-list');
    expect(page.moduleId).toBe(MODULE);
    expect(page.moduleName).toBe('设备台账');
    expect(page.record.id).toBe(RECORD);
    expect(page.record.module).toBe(MODULE);
    expect(page.record.type).toBe(TYPE);
    expect(page.record.note).toBe('列结构由 manifest 定义');
    // queryable 一律给布尔（缺省 = false），前端不必再判 undefined
    expect(page.record.fields).toEqual([
      { key: 'name', label: '设备名', type: 'string', queryable: true, description: '唯一名称' },
      { key: 'count', label: '数量', type: 'number', queryable: false },
    ]);
    // 下发的 module/type 拼回去必须能被 /api/dyn 认出来（这是本端点存在的意义）
    const dyn = await app.request(`/api/dyn/${page.record.module}/${page.record.type}`);
    expect(dyn.status).toBe(200);
  });

  it('内联读写工具 id（前端写操作走 B.5 的 invoke→confirm）', async () => {
    const [page] = await pages(setup());
    expect(page.record.tools).toEqual({
      list: `${RECORD}.list`,
      get: `${RECORD}.get`,
      create: `${RECORD}.create`,
      update: `${RECORD}.update`,
      delete: `${RECORD}.delete`,
    });
    // 工具 id 不是凭空拼的：读工具确实已注册在总线上
    expect(ctx?.ws.tools.list().some((t) => t.id === page.record.tools.list)).toBe(true);
  });

  it('category / icon / description 原样透传（前端白名单映射，服务端不解释）', async () => {
    const [page] = await pages(setup());
    expect(page.category).toBe('registry');
    expect(page.icon).toBe('DatabaseOutlined');
    expect(page.description).toBe('设备清单');
  });

  it('可选字段缺省时键直接缺席（不塞 undefined / null）', async () => {
    ctx = createAppContext({ dbPath: ':memory:', workspaceId: 'ws-ui-routes-test' });
    ctx.ws.modules.install(
      manifest({
        // note 与页面的 description/category/icon 一起省掉：验的是「缺省即键缺席」
        records: [{ id: RECORD, label: '设备', fields: [{ key: 'name', label: '设备名', type: 'string' }] }],
        ui: { pages: [{ id: PAGE, label: '设备', kind: 'record-list', record: RECORD }] },
      }),
    );
    const raw = await (await createApp(ctx).request('/api/ui/pages')).text();
    expect(raw).not.toContain('category');
    expect(raw).not.toContain('icon');
    const page = (JSON.parse(raw) as { pages: UiPage[] }).pages[0];
    expect(page.description).toBeUndefined();
    expect(page.record.note).toBeUndefined();
  });

  it('停用模块的页面不下发（导航里不留死链）', async () => {
    const app = setup();
    expect(await pages(app)).toHaveLength(1);
    const { proposalId } = ctx!.ws.profile.propose('user:test', [
      { op: 'replace', path: `/modules/${MODULE}/enabled`, value: false },
    ]);
    ctx!.ws.profile.confirm(proposalId);
    expect(await pages(app)).toEqual([]);
  });

  it('卸载模块后页面消失（record 白名单与页面清单同源）', async () => {
    const app = setup();
    ctx!.ws.modules.uninstall(MODULE);
    expect(await pages(app)).toEqual([]);
  });

  it('一个模块声明多个页面时全部下发，顺序与 manifest 一致', async () => {
    ctx = createAppContext({ dbPath: ':memory:', workspaceId: 'ws-ui-routes-test' });
    ctx.ws.modules.install(
      manifest({
        records: [
          { id: `dyn.${MODULE}.${TYPE}`, label: '设备', fields: [{ key: 'name', label: '设备名', type: 'string' }] },
          { id: `dyn.${MODULE}.spare`, label: '备件', fields: [{ key: 'code', label: '编码', type: 'string' }] },
        ],
        ui: {
          pages: [
            { id: `ui.${MODULE}.spares`, label: '备件', kind: 'record-list', record: `dyn.${MODULE}.spare` },
            { id: PAGE, label: '设备', kind: 'record-list', record: RECORD },
          ],
        },
      }),
    );
    const list = await pages(createApp(ctx));
    expect(list.map((p) => p.id)).toEqual([`ui.${MODULE}.spares`, PAGE]);
    expect(list.map((p) => p.record.type)).toEqual(['spare', TYPE]);
  });
});
