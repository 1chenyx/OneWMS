import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type EventEnvelope, type PatchOp, type ToolDefinition } from '@one/core';
import {
  LEGACY_SECTION_KEY,
  MEMORY_EVENT_TYPES,
  MemoryDomain,
  RESIDENT_PERSONAL_LINE_BUDGET,
  bodyLineCount,
  memoryManifest,
  readMemorySettings,
  relativeTime,
  renderDirectoryLine,
  renderSectionBody,
  type MemorySection,
  type MemorySectionUpdatedPayload,
  type MemoryWorkspace,
} from '../src/index.js';
import { MAX_APPEND_TEXT_LENGTH, MAX_SECTION_BODY_LENGTH } from '../src/tools/memory-tools.js';

/**
 * 记忆领域 v2（章节级 markdown 账本）：投影 + 幂等/重放 + v1 兼容 + 工具三件套 + 渲染。
 *
 * 断言纪律（与源码注释同源）：
 *  - 事件是唯一真相：投影（memory_section）是可丢的缓存，因此每个写入用例都
 *    同时看「事件落账数」与「投影状态」，校验失败必须零事件；
 *  - base_lamport 取事件自身的 lamport（不是 payload 字段），它是 memory.rewrite
 *    的乐观并发令牌，所以每次写入后都要断言它跟着变；
 *  - v1 的 memory.item.* 事件不再产生，只被投影识别 → 兼容用例直接手工造事件；
 *  - T0 常驻渲染「超预算不截断」是产品纪律（截断会让用户偏好随机失效），
 *    因此 overflow 用例必须同时断言正文完整。
 */

const WS = 'ws-memory';
const ACTOR = 'user:tester@node-1';

let core: OneCore;
let domain: MemoryDomain;
let ws: MemoryWorkspace;

beforeEach(() => {
  core = OneCore.open(':memory:');
  domain = MemoryDomain.attach(core);
  ws = domain.workspace(WS);
});

afterEach(() => {
  core.close();
});

/** 账本事件总数（含模块安装种子事件——用例只关心增量） */
function countEvents(): number {
  let n = 0;
  ws.events.forEach(() => n++);
  return n;
}

/** 让相邻事件的 createdAt 落在不同毫秒（created_at/updated_at 的断言需要可区分的时间戳） */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

/** 手工落一条事件并追账（等价于另一节点同步过来的事件） */
function appendEvent(type: string, payload: unknown, actor = ACTOR): EventEnvelope {
  const env = ws.events.append(type, payload, actor);
  ws.sync();
  return env;
}

/** 造一个合法的 section.updated payload（缺省值即「一节业务约定」） */
function updatedPayload(over: Partial<MemorySectionUpdatedPayload> = {}): MemorySectionUpdatedPayload {
  return {
    sectionId: randomUUID(),
    scope: 'project',
    sectionKey: 'storage-rules',
    title: '存放要求',
    bodyMd: '- A001 易碎',
    summary: '易碎品轻拿轻放',
    keywords: ['存放'],
    ...over,
  };
}

/**
 * 比对投影时抹平章节主键：
 * 正式章节的 id 来自事件 payload.sectionId（可由事件重建），但 v1 遗留事件里
 * 只有 memoryId，legacy-* 收容章节的主键是投影侧 randomUUID 现造的 →
 * 每次重放都会换一个新 id（见交付报告的「疑似 bug」条目）。
 */
function withoutIds(list: readonly MemorySection[]): unknown[] {
  return list.map((s) => ({ ...s, id: '<projector-generated>' }));
}

/** 慢通道改 core.memory 设置（propose → confirm——配置变更的唯一路径） */
function setSettings(patch: PatchOp[]): void {
  const { proposalId } = ws.profile.propose('user:tester', patch, '记忆设置测试');
  ws.profile.confirm(proposalId, 'user:tester');
}

const invoke = (toolId: string, params: unknown): Promise<unknown> =>
  ws.tools.invoke(toolId, params, ACTOR);

/** memory.read 目录项的对外形状（刻意不含 bodyMd——目录就是省 token 的手段） */
interface DirectoryEntry {
  scope: 'personal' | 'project';
  sectionKey: string;
  title: string;
  summary: string;
  keywords: string[];
  lines: number;
  baseLamport: number;
  updatedAt: string;
}

interface SectionOut extends DirectoryEntry {
  bodyMd: string;
  lastActor: string;
}

interface DirectoryOut {
  sections: DirectoryEntry[];
  hint: string;
}

describe('章节投影（memory.section.*）', () => {
  it('首建：字段逐项落位，base_lamport = 事件自身 lamport，created_at/updated_at 同源', () => {
    const payload = updatedPayload({
      scope: 'project',
      sectionKey: 'storage-rules',
      title: '存放要求',
      bodyMd: '- A001 易碎\n- B002 防潮',
      summary: '两句话摘要',
      keywords: ['存放', '防潮'],
    });
    const env = appendEvent(MEMORY_EVENT_TYPES.sectionUpdated, payload);

    const s = ws.sections.byKey('project', 'storage-rules');
    expect(s).toBeDefined();
    expect(s!.id).toBe(payload.sectionId); // 主键用事件携带的 uuid，不自增
    expect(s!.scope).toBe('project');
    expect(s!.sectionKey).toBe('storage-rules');
    expect(s!.title).toBe('存放要求');
    expect(s!.bodyMd).toBe('- A001 易碎\n- B002 防潮');
    expect(s!.summary).toBe('两句话摘要');
    expect(s!.keywords).toEqual(['存放', '防潮']); // 关键词列是 JSON 缓存，读出来还原成数组
    expect(s!.baseLamport).toBe(env.lamport); // 令牌 = 事件 lamport（不是 payload 里的字段）
    expect(s!.lastActor).toBe(ACTOR);
    expect(s!.createdAt).toBe(env.createdAt);
    expect(s!.updatedAt).toBe(env.createdAt);
    expect(ws.sections.count()).toBe(1);
    expect(ws.sections.count('project')).toBe(1);
    expect(ws.sections.count('personal')).toBe(0);
  });

  it('同键再写 = 整节覆盖：created_at 保留首建时间，base_lamport 随写入递增', async () => {
    const first = updatedPayload({ sectionKey: 'storage-rules', title: '旧标题', bodyMd: '- 旧要点' });
    const env1 = appendEvent(MEMORY_EVENT_TYPES.sectionUpdated, first);
    await tick();
    const second = updatedPayload({
      sectionKey: 'storage-rules',
      title: '新标题',
      bodyMd: '- 新要点一\n- 新要点二',
      summary: '新摘要',
      keywords: ['新关键词'],
    });
    const env2 = appendEvent(MEMORY_EVENT_TYPES.sectionUpdated, second);

    expect(ws.sections.count()).toBe(1); // 自然键 (ws, scope, key) upsert，不新增行
    const s = ws.sections.byKey('project', 'storage-rules')!;
    expect(s.title).toBe('新标题');
    expect(s.bodyMd).toBe('- 新要点一\n- 新要点二');
    expect(s.summary).toBe('新摘要');
    expect(s.keywords).toEqual(['新关键词']);
    expect(s.id).toBe(second.sectionId); // 多节点冲突以最后事件为准
    expect(s.createdAt).toBe(env1.createdAt); // ON CONFLICT 不更新 created_at
    expect(s.updatedAt).toBe(env2.createdAt);
    expect(s.baseLamport).toBe(env2.lamport);
    expect(s.baseLamport).toBeGreaterThan(env1.lamport); // 令牌每次写入都变，旧令牌必失效
  });

  it('section.removed 删行；重复删除与删不存在的键都是空操作', () => {
    appendEvent(
      MEMORY_EVENT_TYPES.sectionUpdated,
      updatedPayload({ scope: 'personal', sectionKey: 'user-prefs', title: '用户偏好' }),
    );
    appendEvent(MEMORY_EVENT_TYPES.sectionUpdated, updatedPayload({ sectionKey: 'storage-rules' }));
    expect(ws.sections.count()).toBe(2);

    appendEvent(MEMORY_EVENT_TYPES.sectionRemoved, { scope: 'personal', sectionKey: 'user-prefs' });
    expect(ws.sections.byKey('personal', 'user-prefs')).toBeUndefined();
    expect(ws.sections.count()).toBe(1);

    // 幂等：同一删除再来一次、以及删一个不存在的键，都不影响其余章节
    appendEvent(MEMORY_EVENT_TYPES.sectionRemoved, { scope: 'personal', sectionKey: 'user-prefs' });
    appendEvent(MEMORY_EVENT_TYPES.sectionRemoved, { scope: 'project', sectionKey: 'user-prefs' });
    expect(ws.sections.count()).toBe(1);
    expect(ws.sections.byKey('project', 'storage-rules')).toBeDefined();
  });

  it('list 稳定序：personal 先于 project，同 scope 按建档时间与键名', async () => {
    appendEvent(
      MEMORY_EVENT_TYPES.sectionUpdated,
      updatedPayload({ scope: 'project', sectionKey: 'b-project', title: 'B' }),
    );
    await tick();
    appendEvent(
      MEMORY_EVENT_TYPES.sectionUpdated,
      updatedPayload({ scope: 'personal', sectionKey: 'z-personal', title: 'Z' }),
    );
    await tick();
    appendEvent(
      MEMORY_EVENT_TYPES.sectionUpdated,
      updatedPayload({ scope: 'project', sectionKey: 'a-project', title: 'A' }),
    );

    expect(ws.sections.list().map((s) => s.sectionKey)).toEqual([
      'z-personal', // personal 层恒在前（与 T0 段落顺序一致）
      'b-project', // project 内按 created_at
      'a-project',
    ]);
    expect(ws.sections.list('project').map((s) => s.sectionKey)).toEqual(['b-project', 'a-project']);
    expect(ws.sections.list('personal').map((s) => s.sectionKey)).toEqual(['z-personal']);
  });
});

describe('幂等与重放（事件账本 ↔ 投影强一致）', () => {
  it('同一事件应用两次结果不变（upsert 写同样的值 = 空操作）', () => {
    const payload = updatedPayload({ sectionKey: 'storage-rules', bodyMd: '- A001 易碎' });
    const env = appendEvent(MEMORY_EVENT_TYPES.sectionUpdated, payload);
    const once = ws.sections.list();

    ws.sections.applyEvent(env); // 手动重复应用（模拟重放器/同步重投）
    ws.sections.applyEvent(env);
    expect(ws.sections.list()).toEqual(once);
    expect(ws.sections.count()).toBe(1);
  });

  it('replay 全量重建后与增量追账完全一致；replay 自身幂等', async () => {
    appendEvent(
      MEMORY_EVENT_TYPES.sectionUpdated,
      updatedPayload({ scope: 'personal', sectionKey: 'user-prefs', title: '用户偏好' }),
    );
    await tick();
    const storagePayload = updatedPayload({ sectionKey: 'storage-rules', title: '存放要求' });
    const env2 = appendEvent(MEMORY_EVENT_TYPES.sectionUpdated, storagePayload);
    await tick();
    appendEvent(MEMORY_EVENT_TYPES.itemSaved, {
      memoryId: 'm-legacy',
      scope: 'project',
      content: '老库遗留的一条',
      source: 'manual',
    });
    appendEvent(MEMORY_EVENT_TYPES.sectionRemoved, { scope: 'personal', sectionKey: 'user-prefs' });
    const incremental = ws.sections.list();
    expect(incremental.map((s) => s.sectionKey)).toEqual(['storage-rules', 'legacy-project']);
    const legacyId = ws.sections.byKey('project', 'legacy-project')!.id;

    const stat = ws.replay();
    // 4 条 memory.* 事件（模块安装种子事件不属本域，不计入）
    expect(stat.appliedMemoryEvents).toBe(4);
    expect(withoutIds(ws.sections.list())).toEqual(withoutIds(incremental));

    ws.replay(); // 再来一次：清库重建，状态不变
    expect(withoutIds(ws.sections.list())).toEqual(withoutIds(incremental));
    expect(ws.sections.byKey('project', 'storage-rules')!.baseLamport).toBe(env2.lamport);
    expect(ws.sections.count()).toBe(2);
    // 正式章节的主键由事件重建（payload.sectionId）；legacy 章节是投影凭空长出来的，
    // 主键按自然键确定性派生——同一份账本重放两次必须得到同一份投影
    expect(ws.sections.byKey('project', 'storage-rules')!.id).toBe(storagePayload.sectionId);
    expect(ws.sections.byKey('project', 'legacy-project')!.id).toBe(legacyId);
  });

  it('多工作区隔离：投影互不可见', () => {
    const other = domain.workspace('ws-memory-other');
    appendEvent(MEMORY_EVENT_TYPES.sectionUpdated, updatedPayload({ sectionKey: 'storage-rules' }));
    expect(ws.sections.count()).toBe(1);
    expect(other.sections.count()).toBe(0);
    expect(other.sections.byKey('project', 'storage-rules')).toBeUndefined();
  });
});

describe('v1 兼容：memory.item.* 投影进 legacy 收容章节', () => {
  it('itemSaved → legacy-<scope> 章节出现，正文行形如 `- [memoryId] content`', () => {
    const env = appendEvent(MEMORY_EVENT_TYPES.itemSaved, {
      memoryId: 'm-1',
      scope: 'personal',
      content: '偏好简短回复',
      source: 'manual',
    });
    const key = LEGACY_SECTION_KEY.personal;
    expect(key).toBe('legacy-personal');
    const s = ws.sections.byKey('personal', key)!;
    expect(s).toBeDefined();
    expect(s.title).toBe('历史条目（未归并）');
    expect(s.summary).toContain('迁移收容区');
    expect(s.keywords).toEqual(['历史条目', '待归并']);
    expect(s.bodyMd).toBe('- [m-1] 偏好简短回复');
    expect(s.baseLamport).toBe(env.lamport);

    // 第二条追加成第二行；project 层另有独立收容章节
    appendEvent(MEMORY_EVENT_TYPES.itemSaved, {
      memoryId: 'm-2',
      scope: 'personal',
      content: '周日盘点',
      source: 'auto',
    });
    appendEvent(MEMORY_EVENT_TYPES.itemSaved, {
      memoryId: 'm-3',
      scope: 'project',
      content: 'A001 易碎',
      source: 'ai',
    });
    expect(ws.sections.byKey('personal', key)!.bodyMd.split('\n')).toEqual([
      '- [m-1] 偏好简短回复',
      '- [m-2] 周日盘点',
    ]);
    expect(ws.sections.byKey('project', LEGACY_SECTION_KEY.project)!.bodyMd).toBe('- [m-3] A001 易碎');
    expect(ws.sections.count()).toBe(2);
  });

  it('重复应用同一 itemSaved 不重复追加（行内 memoryId 是去重标记）', () => {
    const env = appendEvent(MEMORY_EVENT_TYPES.itemSaved, {
      memoryId: 'm-1',
      scope: 'personal',
      content: '偏好简短回复',
      source: 'manual',
    });
    ws.sections.applyEvent(env);
    ws.sections.applyEvent(env);
    ws.sync();
    const body = ws.sections.byKey('personal', LEGACY_SECTION_KEY.personal)!.bodyMd;
    expect(body.split('\n')).toHaveLength(1);
    expect(body).toBe('- [m-1] 偏好简短回复');
  });

  it('itemForgotten 摘掉对应行；章节空了整节删除', () => {
    appendEvent(MEMORY_EVENT_TYPES.itemSaved, {
      memoryId: 'm-1',
      scope: 'personal',
      content: '偏好简短回复',
      source: 'manual',
    });
    appendEvent(MEMORY_EVENT_TYPES.itemSaved, {
      memoryId: 'm-2',
      scope: 'personal',
      content: '周日盘点',
      source: 'manual',
    });
    const key = LEGACY_SECTION_KEY.personal;

    appendEvent(MEMORY_EVENT_TYPES.itemForgotten, { memoryId: 'm-1' });
    expect(ws.sections.byKey('personal', key)!.bodyMd).toBe('- [m-2] 周日盘点');

    appendEvent(MEMORY_EVENT_TYPES.itemForgotten, { memoryId: 'm-2' });
    expect(ws.sections.byKey('personal', key)).toBeUndefined(); // 空章节不留在目录里
    expect(ws.sections.count()).toBe(0);

    // 遗忘不存在的 id：空操作，不炸读路径
    appendEvent(MEMORY_EVENT_TYPES.itemForgotten, { memoryId: 'ghost' });
    expect(ws.sections.count()).toBe(0);
  });

  it('v1 事件重放后与增量追账一致（老库开新进程的路径）', () => {
    appendEvent(MEMORY_EVENT_TYPES.itemSaved, {
      memoryId: 'm-1',
      scope: 'project',
      content: 'A001 易碎',
      source: 'manual',
    });
    appendEvent(MEMORY_EVENT_TYPES.itemSaved, {
      memoryId: 'm-2',
      scope: 'project',
      content: 'B002 防潮',
      source: 'ai',
    });
    appendEvent(MEMORY_EVENT_TYPES.itemForgotten, { memoryId: 'm-1' });
    const incremental = ws.sections.list();
    expect(incremental).toHaveLength(1);
    expect(incremental[0].bodyMd).toBe('- [m-2] B002 防潮');

    const stat = ws.replay();
    expect(stat.appliedMemoryEvents).toBe(3);
    // 重放不重复追加、不误删（legacy 章节主键是投影现造的，见 withoutIds 注释）
    expect(withoutIds(ws.sections.list())).toEqual(withoutIds(incremental));
  });
});

describe('工具 memory.append（低摩擦追加，免并发令牌）', () => {
  it('新建章节：带 title 用 title，散句自动补 `- ` 前缀，summary 取首条要点', async () => {
    const before = countEvents();
    const out = (await invoke('memory.append', {
      scope: 'project',
      sectionKey: 'sku-characteristics',
      title: 'SKU 特性',
      text: 'A001 是易碎品，搬运需轻拿轻放',
    })) as SectionOut;
    expect(countEvents()).toBe(before + 1);
    expect(out.scope).toBe('project');
    expect(out.sectionKey).toBe('sku-characteristics');
    expect(out.title).toBe('SKU 特性');
    expect(out.bodyMd).toBe('- A001 是易碎品，搬运需轻拿轻放');
    expect(out.lines).toBe(1);
    expect(out.summary).toBe('A001 是易碎品，搬运需轻拿轻放');
    expect(out.keywords).toEqual([]); // append 不编关键词——那是 rewrite 的活
    expect(out.lastActor).toBe(ACTOR);

    const s = ws.sections.byKey('project', 'sku-characteristics')!;
    expect(s.baseLamport).toBe(out.baseLamport);
    expect(s.bodyMd).toBe(out.bodyMd);
  });

  it('新建章节无 title：标题回退为 sectionKey 去连字符', async () => {
    const out = (await invoke('memory.append', {
      scope: 'project',
      sectionKey: 'supplier-agreements',
      text: '每月底与供应商对账',
    })) as SectionOut;
    expect(out.title).toBe('supplier agreements');

    // 已经是 markdown 结构行时不再补前缀：结构行判定是 `^(#{1,6}|[-*>]|\d+[.)])\s`
    const out2 = (await invoke('memory.append', {
      scope: 'project',
      sectionKey: 'supplier-agreements',
      text: '# 结算',
    })) as SectionOut;
    expect(out2.bodyMd).toBe('- 每月底与供应商对账\n# 结算');

    const out3 = (await invoke('memory.append', {
      scope: 'project',
      sectionKey: 'supplier-agreements',
      text: '1. 每月底对账',
    })) as SectionOut;
    expect(out3.bodyMd).toBe('- 每月底与供应商对账\n# 结算\n1. 每月底对账');

    // 多级标题（## … ######）同样算结构行：只认一个井号会把标题补成 `- ## 结算周期`，
    // 渲染出来是列表项里套标题
    const out4 = (await invoke('memory.append', {
      scope: 'project',
      sectionKey: 'supplier-agreements',
      text: '## 结算周期',
    })) as SectionOut;
    expect(out4.bodyMd.endsWith('\n## 结算周期')).toBe(true);
  });

  it('追加到既有章节：正文按行累积，title/summary/keywords 沿用旧值', async () => {
    await invoke('memory.rewrite', {
      scope: 'project',
      sectionKey: 'sku-characteristics',
      title: 'SKU 特性',
      bodyMd: '- A001 易碎',
      summary: '旧摘要',
      keywords: ['SKU', '易碎'],
      baseLamport: 0,
    });
    const before = ws.sections.byKey('project', 'sku-characteristics')!;

    const out = (await invoke('memory.append', {
      scope: 'project',
      sectionKey: 'sku-characteristics',
      text: 'B002 需防潮',
    })) as SectionOut;
    expect(out.bodyMd).toBe('- A001 易碎\n- B002 需防潮');
    expect(out.lines).toBe(2);
    expect(out.title).toBe('SKU 特性'); // 追加不动标题
    expect(out.summary).toBe('旧摘要'); // 追加不动摘要
    expect(out.keywords).toEqual(['SKU', '易碎']); // 追加不动关键词
    expect(out.baseLamport).toBeGreaterThan(before.baseLamport); // 令牌随写入递增
    expect(out.baseLamport).toBe(ws.sections.byKey('project', 'sku-characteristics')!.baseLamport);
  });

  it('text 空白 / 超长 → 拒绝且零事件', async () => {
    const before = countEvents();
    await expect(
      invoke('memory.append', { scope: 'project', sectionKey: 'a-key', text: '   ' }),
    ).rejects.toThrow('TOOL_REJECTED');
    await expect(
      invoke('memory.append', {
        scope: 'project',
        sectionKey: 'a-key',
        text: '长'.repeat(MAX_APPEND_TEXT_LENGTH + 1),
      }),
    ).rejects.toThrow('TOOL_REJECTED');
    expect(countEvents()).toBe(before);
    expect(ws.sections.count()).toBe(0);
  });

  it('非法 sectionKey → 拒绝且零事件（首字符/字符集/长度三条规则）', async () => {
    const before = countEvents();
    for (const sectionKey of ['Bad Key', '-lead-dash', 'under_score', 'a', 'x'.repeat(49)]) {
      await expect(
        invoke('memory.append', { scope: 'project', sectionKey, text: '一条要点' }),
      ).rejects.toThrow('TOOL_REJECTED');
    }
    expect(countEvents()).toBe(before);
    expect(ws.sections.count()).toBe(0);
  });

  it('正文将超单节上限 → 拒绝并提示改用 rewrite，既有正文不变', async () => {
    await invoke('memory.rewrite', {
      scope: 'project',
      sectionKey: 'big-section',
      title: '大章节',
      bodyMd: '长'.repeat(MAX_SECTION_BODY_LENGTH - 1), // 5999 字：再追加一行必越界
      baseLamport: 0,
    });
    const before = countEvents();
    const beforeBody = ws.sections.byKey('project', 'big-section')!.bodyMd;
    await expect(
      invoke('memory.append', { scope: 'project', sectionKey: 'big-section', text: '再记一条要点' }),
    ).rejects.toThrow('TOOL_REJECTED');
    await expect(
      invoke('memory.append', { scope: 'project', sectionKey: 'big-section', text: '再记一条要点' }),
    ).rejects.toThrow(String(MAX_SECTION_BODY_LENGTH)); // 错误消息带上限值，便于 AI 自纠
    expect(countEvents()).toBe(before);
    expect(ws.sections.byKey('project', 'big-section')!.bodyMd).toBe(beforeBody);
  });

  it('章节数达 maxSections：新建被拒，既有章节仍可追加，删一节后又可新建', async () => {
    setSettings([
      { op: 'replace', path: '/modules/core.memory/settings/maxSections', value: 2 },
    ]);
    await invoke('memory.append', { scope: 'project', sectionKey: 'sec-one', text: '一' });
    await invoke('memory.append', { scope: 'personal', sectionKey: 'sec-two', text: '二' });
    expect(ws.sections.count()).toBe(2);

    const before = countEvents();
    await expect(
      invoke('memory.append', { scope: 'project', sectionKey: 'sec-three', text: '三' }),
    ).rejects.toThrow('TOOL_REJECTED');
    // rewrite 新建同样受上限约束（两个写口共用同一护栏）
    await expect(
      invoke('memory.rewrite', {
        scope: 'project',
        sectionKey: 'sec-four',
        title: '四',
        bodyMd: '- 四',
        baseLamport: 0,
      }),
    ).rejects.toThrow('TOOL_REJECTED');
    expect(countEvents()).toBe(before);
    expect(ws.sections.count()).toBe(2);

    // 既有章节不受上限影响（上限只管「新建」）
    await expect(
      invoke('memory.append', { scope: 'project', sectionKey: 'sec-one', text: '一之二' }),
    ).resolves.toBeTruthy();
    expect(ws.sections.byKey('project', 'sec-one')!.bodyMd).toBe('- 一\n- 一之二');

    // 正文留空 = 删除整节 → 腾出名额后又能新建
    await invoke('memory.rewrite', {
      scope: 'project',
      sectionKey: 'sec-one',
      title: '一',
      bodyMd: '   ',
      baseLamport: ws.sections.byKey('project', 'sec-one')!.baseLamport,
    });
    await expect(
      invoke('memory.append', { scope: 'project', sectionKey: 'sec-three', text: '三' }),
    ).resolves.toBeTruthy();
    expect(ws.sections.count()).toBe(2);
  });

  it('scope 非法 → 拒绝且零事件（总线 enum 先拦一层）', async () => {
    const before = countEvents();
    await expect(
      invoke('memory.append', { scope: 'global', sectionKey: 'sec-one', text: '一' }),
    ).rejects.toThrow();
    expect(countEvents()).toBe(before);
  });
});

describe('工具 memory.rewrite（整节覆盖 + 乐观并发令牌）', () => {
  it('正常覆盖：正文/标题/摘要/关键词全部重算，令牌换成新事件的 lamport', async () => {
    const created = (await invoke('memory.rewrite', {
      scope: 'project',
      sectionKey: 'sku-characteristics',
      title: 'SKU 特性',
      bodyMd: '- A001 易碎\n- B002 防潮',
      summary: '两条商品特性',
      keywords: ['SKU', 'A001', '易碎'],
      baseLamport: 0, // 新建章节传 0
    })) as SectionOut;
    expect(created.bodyMd).toBe('- A001 易碎\n- B002 防潮');
    expect(created.summary).toBe('两条商品特性');
    expect(created.keywords).toEqual(['SKU', 'A001', '易碎']);
    expect(ws.sections.count()).toBe(1);
    const idBeforeRewrite = ws.sections.byKey('project', 'sku-characteristics')!.id;

    const rewritten = (await invoke('memory.rewrite', {
      scope: 'project',
      sectionKey: 'sku-characteristics',
      title: '商品特性（已归并）',
      bodyMd: '- A001 易碎，需轻拿轻放',
      summary: '归并后只剩一条',
      keywords: ['SKU', '易碎品'],
      baseLamport: created.baseLamport,
    })) as SectionOut;
    expect(rewritten.title).toBe('商品特性（已归并）');
    expect(rewritten.bodyMd).toBe('- A001 易碎，需轻拿轻放');
    expect(rewritten.summary).toBe('归并后只剩一条');
    expect(rewritten.keywords).toEqual(['SKU', '易碎品']);
    expect(rewritten.baseLamport).toBeGreaterThan(created.baseLamport);
    expect(ws.sections.count()).toBe(1); // 覆盖不是新增
    // 章节主键沿用原 id（工具从投影取 existing.id，不重新生成）
    expect(ws.sections.byKey('project', 'sku-characteristics')!.id).toBe(idBeforeRewrite);
  });

  it('summary 省略 → 回退正文首行；keywords 规整（去空白、去重）', async () => {
    const out = (await invoke('memory.rewrite', {
      scope: 'project',
      sectionKey: 'fifo-policy',
      title: '先进先出',
      bodyMd: '出库默认按 FIFO 分配批次\n- 细则在正文里',
      keywords: ['  ', 'FIFO', 'FIFO', '先进先出', ' FIFO '],
      baseLamport: 0,
    })) as SectionOut;
    expect(out.summary).toBe('出库默认按 FIFO 分配批次');
    expect(out.keywords).toEqual(['FIFO', '先进先出']); // 空白剔除、trim 后重复合并
  });

  it('keywords 超 8 个 → 只保留前 8 个（防目录行无限变长）', async () => {
    const out = (await invoke('memory.rewrite', {
      scope: 'project',
      sectionKey: 'many-keywords',
      title: '关键词很多',
      bodyMd: '- 一条',
      keywords: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9', 'k10'],
      baseLamport: 0,
    })) as SectionOut;
    expect(out.keywords).toEqual(['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8']);
  });

  it('关键词超 16 字 → 拒绝', async () => {
    const before = countEvents();
    await expect(
      invoke('memory.rewrite', {
        scope: 'project',
        sectionKey: 'fifo-policy',
        title: '先进先出',
        bodyMd: '- 一条',
        keywords: ['超'.repeat(17)],
        baseLamport: 0,
      }),
    ).rejects.toThrow('TOOL_REJECTED');
    expect(countEvents()).toBe(before);
  });

  it('baseLamport 不符 → 拒绝并提示「已被其他写入更新」，零事件', async () => {
    const created = (await invoke('memory.rewrite', {
      scope: 'project',
      sectionKey: 'sku-characteristics',
      title: 'SKU 特性',
      bodyMd: '- A001 易碎',
      baseLamport: 0,
    })) as SectionOut;
    const before = countEvents();

    await expect(
      invoke('memory.rewrite', {
        scope: 'project',
        sectionKey: 'sku-characteristics',
        title: 'SKU 特性',
        bodyMd: '- 陈旧写入',
        baseLamport: created.baseLamport + 1, // 拿着过期/编造的令牌
      }),
    ).rejects.toThrow('已被其他写入更新');
    expect(countEvents()).toBe(before);
    expect(ws.sections.byKey('project', 'sku-characteristics')!.bodyMd).toBe('- A001 易碎');

    // 并发场景：别人先写了一手，我手里的旧令牌必须失效
    await invoke('memory.append', { scope: 'project', sectionKey: 'sku-characteristics', text: '别人追加的' });
    await expect(
      invoke('memory.rewrite', {
        scope: 'project',
        sectionKey: 'sku-characteristics',
        title: 'SKU 特性',
        bodyMd: '- 陈旧写入',
        baseLamport: created.baseLamport,
      }),
    ).rejects.toThrow('TOOL_REJECTED');
    expect(ws.sections.byKey('project', 'sku-characteristics')!.bodyMd).toBe(
      '- A001 易碎\n- 别人追加的',
    );
  });

  it('新建章节传非 0 令牌 → 拒绝（期望 0）', async () => {
    const before = countEvents();
    await expect(
      invoke('memory.rewrite', {
        scope: 'project',
        sectionKey: 'brand-new',
        title: '新章节',
        bodyMd: '- 一条',
        baseLamport: 7,
      }),
    ).rejects.toThrow('TOOL_REJECTED');
    expect(countEvents()).toBe(before);
    expect(ws.sections.count()).toBe(0);
  });

  it('bodyMd 空白 = 删除整节：返回 {removed:true}，投影中该节消失', async () => {
    const created = (await invoke('memory.rewrite', {
      scope: 'personal',
      sectionKey: 'user-prefs',
      title: '用户偏好',
      bodyMd: '- 偏好简短回复',
      baseLamport: 0,
    })) as SectionOut;
    expect(ws.sections.count()).toBe(1);

    const out = (await invoke('memory.rewrite', {
      scope: 'personal',
      sectionKey: 'user-prefs',
      title: '用户偏好',
      bodyMd: '   ',
      baseLamport: created.baseLamport,
    })) as { removed: boolean; scope: string; sectionKey: string };
    expect(out).toEqual({ removed: true, scope: 'personal', sectionKey: 'user-prefs' });
    expect(ws.sections.byKey('personal', 'user-prefs')).toBeUndefined();
    expect(ws.sections.count()).toBe(0);

    // 删除也是事件：账本里留下 section.removed（历史不可抹）
    const types: string[] = [];
    ws.events.forEach((env) => types.push(env.type));
    expect(types.filter((t) => t === MEMORY_EVENT_TYPES.sectionRemoved)).toHaveLength(1);
  });

  it('删除不存在的章节 → 拒绝且零事件', async () => {
    const before = countEvents();
    await expect(
      invoke('memory.rewrite', {
        scope: 'project',
        sectionKey: 'no-such-section',
        title: '不存在',
        bodyMd: '',
        baseLamport: 0,
      }),
    ).rejects.toThrow('TOOL_REJECTED');
    expect(countEvents()).toBe(before);
  });

  it('非删除写入必须给 title；bodyMd 超上限拒绝', async () => {
    const before = countEvents();
    await expect(
      invoke('memory.rewrite', {
        scope: 'project',
        sectionKey: 'no-title',
        title: '   ',
        bodyMd: '- 一条',
        baseLamport: 0,
      }),
    ).rejects.toThrow('TOOL_REJECTED');
    await expect(
      invoke('memory.rewrite', {
        scope: 'project',
        sectionKey: 'too-long',
        title: '太长',
        bodyMd: '长'.repeat(MAX_SECTION_BODY_LENGTH + 1),
        baseLamport: 0,
      }),
    ).rejects.toThrow('TOOL_REJECTED');
    expect(countEvents()).toBe(before);
    expect(ws.sections.count()).toBe(0);
  });
});

describe('工具 memory.read（T1 按需读）', () => {
  beforeEach(async () => {
    await invoke('memory.append', {
      scope: 'personal',
      sectionKey: 'user-prefs',
      title: '用户偏好',
      text: '偏好简短回复',
    });
    await invoke('memory.rewrite', {
      scope: 'project',
      sectionKey: 'sku-characteristics',
      title: 'SKU 特性',
      bodyMd: '- A001 易碎\n- B002 防潮',
      summary: '两条商品特性',
      keywords: ['SKU', '易碎'],
      baseLamport: 0,
    });
  });

  it('无参 = 目录：含 lines 与 baseLamport，不含 bodyMd', async () => {
    const out = (await invoke('memory.read', {})) as DirectoryOut;
    expect(out.sections).toHaveLength(2);
    expect(out.hint).toContain('memory.rewrite');
    // personal 恒在前（与 T0 段落顺序一致）
    expect(out.sections.map((s) => s.sectionKey)).toEqual(['user-prefs', 'sku-characteristics']);
    const project = out.sections[1];
    expect(project).toEqual({
      scope: 'project',
      sectionKey: 'sku-characteristics',
      title: 'SKU 特性',
      summary: '两条商品特性',
      keywords: ['SKU', '易碎'],
      lines: 2,
      baseLamport: ws.sections.byKey('project', 'sku-characteristics')!.baseLamport,
      updatedAt: ws.sections.byKey('project', 'sku-characteristics')!.updatedAt,
    });
    // 目录是省 token 的手段：正文与审计字段都不出现
    for (const s of out.sections) {
      expect(Object.keys(s)).not.toContain('bodyMd');
      expect(Object.keys(s)).not.toContain('lastActor');
    }
  });

  it('scope 过滤：目录只列该层章节', async () => {
    const personal = (await invoke('memory.read', { scope: 'personal' })) as DirectoryOut;
    const project = (await invoke('memory.read', { scope: 'project' })) as DirectoryOut;
    expect(personal.sections.map((s) => s.sectionKey)).toEqual(['user-prefs']);
    expect(project.sections.map((s) => s.sectionKey)).toEqual(['sku-characteristics']);
    await expect(invoke('memory.read', { scope: 'global' })).rejects.toThrow();
  });

  it('带 sectionKey = 该节全文（含 bodyMd 与 lastActor）', async () => {
    const out = (await invoke('memory.read', { sectionKey: 'sku-characteristics' })) as SectionOut;
    expect(out.bodyMd).toBe('- A001 易碎\n- B002 防潮');
    expect(out.title).toBe('SKU 特性');
    expect(out.lastActor).toBe(ACTOR);
    expect(out.baseLamport).toBe(ws.sections.byKey('project', 'sku-characteristics')!.baseLamport);
    expect(out.lines).toBe(2);
  });

  it('不存在的 sectionKey → 拒绝并提示先看目录', async () => {
    await expect(invoke('memory.read', { sectionKey: 'no-such' })).rejects.toThrow('TOOL_REJECTED');
    await expect(invoke('memory.read', { sectionKey: 'Bad Key' })).rejects.toThrow('TOOL_REJECTED');
  });

  it('带 sectionKey 时 scope 只是提示：给了不匹配的 scope 仍回退两层查找', async () => {
    // 现状（可疑之处，见交付报告）：scope=personal + project 的键 → 命中 project 章节
    const out = (await invoke('memory.read', {
      scope: 'personal',
      sectionKey: 'sku-characteristics',
    })) as SectionOut;
    expect(out.scope).toBe('project');
    expect(out.bodyMd).toBe('- A001 易碎\n- B002 防潮');
  });
});

describe('matchSections（T2 关键词预取）', () => {
  beforeEach(async () => {
    const seed = (sectionKey: string, title: string, keywords: string[], bodyMd: string) =>
      appendEvent(
        MEMORY_EVENT_TYPES.sectionUpdated,
        updatedPayload({ scope: 'project', sectionKey, title, keywords, bodyMd }),
      );
    seed('sku-characteristics', 'SKU 特性', ['SKU', 'A001', '易碎'], '- A001 易碎');
    await tick();
    seed('supplier-agreements', '供应商约定', ['供应商', '对账'], '- 每月底对账');
    await tick();
    seed('fifo-policy', '先进先出策略', ['FIFO', '先进先出'], '- 出库按 FIFO');
    await tick();
    appendEvent(
      MEMORY_EVENT_TYPES.sectionUpdated,
      updatedPayload({
        scope: 'personal',
        sectionKey: 'user-prefs',
        title: '用户偏好',
        keywords: ['盘点'],
        bodyMd: '- 周日盘点',
      }),
    );
  });

  it('关键词命中（大小写不敏感），返回该节全文', () => {
    const hits = ws.sections.matchSections('帮我看看 sku 的特性');
    expect(hits.map((s) => s.sectionKey)).toContain('sku-characteristics');
    expect(hits[0].bodyMd).toBe('- A001 易碎'); // 预取直接给全文，省一次工具往返
  });

  it('标题命中权重高于关键词命中（同文本时标题命中排前）', () => {
    appendEvent(
      MEMORY_EVENT_TYPES.sectionUpdated,
      updatedPayload({
        scope: 'project',
        sectionKey: 'title-hit',
        title: '防潮要求',
        keywords: ['zzz'],
        bodyMd: '- 标题命中我',
      }),
    );
    appendEvent(
      MEMORY_EVENT_TYPES.sectionUpdated,
      updatedPayload({
        scope: 'project',
        sectionKey: 'kw-hit',
        title: 'yyy',
        keywords: ['防潮'],
        bodyMd: '- 关键词命中我',
      }),
    );
    // 标题命中要求「用户消息里出现完整标题」（+3），关键词命中只要包含关键词（+2）
    const hits = ws.sections.matchSections('防潮要求 是怎么定的', 10);
    expect(hits.map((s) => s.sectionKey)).toEqual(['title-hit', 'kw-hit']);
  });

  it('只匹配 project 章节：personal 已在 T0 全文常驻，命中也不返回', () => {
    expect(ws.sections.matchSections('我一般什么时候盘点')).toEqual([]);
    expect(ws.sections.matchSections('用户偏好')).toEqual([]);
    // personal 章节确实在库里（不是被误删导致空结果）
    expect(ws.sections.byKey('personal', 'user-prefs')).toBeDefined();
  });

  it('无命中 / 空白文本 → 空数组；单字符关键词不参与匹配', () => {
    expect(ws.sections.matchSections('今天天气不错')).toEqual([]);
    expect(ws.sections.matchSections('   ')).toEqual([]);
    expect(ws.sections.matchSections('')).toEqual([]);

    appendEvent(
      MEMORY_EVENT_TYPES.sectionUpdated,
      updatedPayload({
        scope: 'project',
        sectionKey: 'single-char',
        title: 'zzz-title',
        keywords: ['A'],
        bodyMd: '- 单字符关键词',
      }),
    );
    expect(ws.sections.matchSections('A')).toEqual([]); // needle 长度 < 2 直接跳过（否则处处误命中）
  });

  it('limit 生效（默认 2），命中分相同按最近更新时间倒序', () => {
    const text = '关于 SKU、供应商 与 先进先出 的约定';
    const all = ws.sections.matchSections(text, 10);
    expect(all).toHaveLength(3);
    expect(ws.sections.matchSections(text).map((s) => s.sectionKey)).toHaveLength(2); // 默认 limit=2
    expect(ws.sections.matchSections(text, 2).map((s) => s.sectionKey)).toEqual(
      all.slice(0, 2).map((s) => s.sectionKey),
    );
    expect(ws.sections.matchSections(text, 0)).toEqual([]);
    // 三节同为「一个关键词命中」→ 同分，取最近更新者在前（fifo 最后建档）
    expect(all.map((s) => s.sectionKey)).toEqual([
      'fifo-policy',
      'supplier-agreements',
      'sku-characteristics',
    ]);
  });
});

describe('resident()（T0 常驻渲染：personal 全文 + project 目录）', () => {
  it('personal 全文出现，project 只出现目录行（正文不进 T0）', () => {
    appendEvent(
      MEMORY_EVENT_TYPES.sectionUpdated,
      updatedPayload({
        scope: 'personal',
        sectionKey: 'user-prefs',
        title: '用户偏好',
        bodyMd: '- 偏好简短回复\n- 叫我老板',
        summary: '称呼与回复风格',
        keywords: ['称呼'],
      }),
    );
    appendEvent(
      MEMORY_EVENT_TYPES.sectionUpdated,
      updatedPayload({
        scope: 'project',
        sectionKey: 'storage-rules',
        title: '存放要求',
        bodyMd: '- A001 易碎\n- B002 防潮',
        summary: '易碎品轻拿轻放',
        keywords: ['存放', '防潮'],
      }),
    );

    const { text, overflow } = ws.sections.resident();
    expect(overflow).toBe(false);
    // personal：整节全文（小标题 + 正文）
    expect(text).toContain('## 关于用户');
    expect(text).toContain('### 用户偏好');
    expect(text).toContain('- 偏好简短回复');
    expect(text).toContain('- 叫我老板');
    // project：只有一行目录（标题 / sectionKey / 行数 / 关键词 / 相对时间 / 摘要）
    expect(text).toContain('## 业务约定（1 节目录');
    expect(text).toContain('memory.read');
    expect(text).toContain('- 存放要求（key=storage-rules · 2 行 · 关键词 存放/防潮 · 更新于 刚刚）：易碎品轻拿轻放');
    expect(text).not.toContain('- A001 易碎'); // 正文按需读取，不常驻
    expect(text).not.toContain('### 存放要求');
    // personal 段在 project 段之前（渲染顺序 = 投影稳定序）
    expect(text.indexOf('## 关于用户')).toBeLessThan(text.indexOf('## 业务约定'));
  });

  it('无记忆：text 为空串且 overflow=false（调用方整段跳过）', () => {
    expect(ws.sections.resident()).toEqual({ text: '', overflow: false });
  });

  it('personal 超行数预算：overflow=true 且正文一字未截断', () => {
    const lines = Array.from({ length: RESIDENT_PERSONAL_LINE_BUDGET + 5 }, (_, i) => `- 偏好第 ${i} 条`);
    appendEvent(
      MEMORY_EVENT_TYPES.sectionUpdated,
      updatedPayload({
        scope: 'personal',
        sectionKey: 'user-prefs',
        title: '用户偏好',
        bodyMd: lines.join('\n'),
        summary: '超预算的画像',
        keywords: [],
      }),
    );
    const { text, overflow } = ws.sections.resident();
    expect(overflow).toBe(true); // 超预算只置标记，由调用方触发归并
    expect(text).toContain(`- 偏好第 ${RESIDENT_PERSONAL_LINE_BUDGET + 4} 条`); // 最后一条仍在 = 未截断
    expect(text).toContain('- 偏好第 0 条');
    expect(bodyLineCount(ws.sections.byKey('personal', 'user-prefs')!.bodyMd)).toBe(
      RESIDENT_PERSONAL_LINE_BUDGET + 5,
    );
  });

  it('只有 project 章节：无「关于用户」段，overflow=false', () => {
    appendEvent(
      MEMORY_EVENT_TYPES.sectionUpdated,
      updatedPayload({ scope: 'project', sectionKey: 'storage-rules', keywords: [] }),
    );
    const { text, overflow } = ws.sections.resident();
    expect(overflow).toBe(false);
    expect(text).not.toContain('## 关于用户');
    expect(text).toContain('## 业务约定（1 节目录');
    // 关键词为空时目录行省略该段（不输出「关键词 」空壳）
    expect(text).not.toContain('关键词');
    expect(text).toContain('- 存放要求（key=storage-rules · 1 行 · 更新于 刚刚）：易碎品轻拿轻放');
  });
});

describe('渲染辅助（render.ts 纯函数）', () => {
  const NOW = Date.parse('2026-11-07T12:00:00.000Z');
  const isoBefore = (ms: number) => new Date(NOW - ms).toISOString();

  it('relativeTime：刚刚 / 分钟 / 小时 / 天 / 月 / 超一年回落日期 / 脏值兜底', () => {
    expect(relativeTime(isoBefore(30_000), NOW)).toBe('刚刚');
    expect(relativeTime(isoBefore(5 * 60_000), NOW)).toBe('5 分钟前');
    expect(relativeTime(isoBefore(3 * 3_600_000), NOW)).toBe('3 小时前');
    expect(relativeTime(isoBefore(2 * 86_400_000), NOW)).toBe('2 天前');
    expect(relativeTime(isoBefore(45 * 86_400_000), NOW)).toBe('1 个月前');
    const old = isoBefore(400 * 86_400_000);
    expect(relativeTime(old, NOW)).toBe(old.slice(0, 10)); // 超 12 个月：绝对日期比「13 个月前」更有用
    expect(relativeTime('不是时间', NOW)).toBe('未知时间');
  });

  it('bodyLineCount：空白为 0，尾随换行不计行', () => {
    expect(bodyLineCount('')).toBe(0);
    expect(bodyLineCount('   \n ')).toBe(0);
    expect(bodyLineCount('- 一条')).toBe(1);
    expect(bodyLineCount('- 一条\n- 两条\n')).toBe(2);
  });

  it('renderSectionBody / renderDirectoryLine 的形状', () => {
    const s: MemorySection = {
      id: 'id-1',
      scope: 'project',
      sectionKey: 'storage-rules',
      title: '存放要求',
      bodyMd: '- A001 易碎\n',
      summary: '易碎品轻拿轻放',
      keywords: ['存放'],
      baseLamport: 9,
      lastActor: ACTOR,
      createdAt: isoBefore(3_600_000),
      updatedAt: isoBefore(3_600_000),
    };
    expect(renderSectionBody(s)).toBe('### 存放要求\n- A001 易碎');
    expect(renderDirectoryLine(s, NOW)).toBe(
      '- 存放要求（key=storage-rules · 1 行 · 关键词 存放 · 更新于 1 小时前）：易碎品轻拿轻放',
    );
    expect(renderDirectoryLine({ ...s, summary: '  ', keywords: [] }, NOW)).toBe(
      '- 存放要求（key=storage-rules · 1 行 · 更新于 1 小时前）', // 摘要空白则不挂冒号
    );
  });
});

describe('manifest 与 settings', () => {
  it('memoryManifest：版本 0.2.0，settings schema 含 autoMemory(默认 true) 与 maxSections(默认 24)', () => {
    const tool: ToolDefinition = {
      id: 'memory.read',
      label: '读记忆',
      description: 'd',
      parameters: { type: 'object' },
      permission: 'read',
      handler: () => null,
    };
    const m = memoryManifest([tool]);
    expect(m.id).toBe('core.memory');
    expect(m.version).toBe('0.2.0');
    const props = m.settings?.schema.properties ?? {};
    expect(props.autoMemory?.type).toBe('boolean');
    expect(props.autoMemory?.default).toBe(true);
    expect(props.maxSections?.type).toBe('integer');
    expect(props.maxSections?.default).toBe(24);
    expect(props.maxSections?.minimum).toBe(1);
    // 声明面从工具定义派生：handler 必须被剥掉（manifest 会持久化，不能带函数）
    expect(m.tools).toHaveLength(1);
    expect(Object.keys(m.tools[0])).not.toContain('handler');
  });

  it('install 把 manifest 缺省种子进 profile 快照', () => {
    const mod = ws.profile.getSnapshot().modules['core.memory'];
    expect(mod?.enabled).toBe(true);
    expect(mod?.version).toBe('0.2.0');
    expect(mod?.settings).toEqual({ autoMemory: true, maxSections: 24 });
  });

  it('readMemorySettings：空快照兜底默认值', () => {
    // 老库/未安装模块时快照里没有 core.memory —— 读取方必须兜底，不能抛
    const empty = { profile: { getSnapshot: () => ({ modules: {} }) } } as unknown as MemoryWorkspace;
    expect(readMemorySettings(empty)).toEqual({ autoMemory: true, maxSections: 24 });
    expect(readMemorySettings(ws)).toEqual({ autoMemory: true, maxSections: 24 });
  });

  it('readMemorySettings：脏值窄化（非整数/小于 1 回落 24；autoMemory 非 false 回落 true）', () => {
    setSettings([
      { op: 'replace', path: '/modules/core.memory/settings/maxSections', value: 'many' },
      { op: 'replace', path: '/modules/core.memory/settings/autoMemory', value: 'nope' },
    ]);
    // 快照是脏面：慢通道能写任意值，原样存着
    expect(ws.profile.getSnapshot().modules['core.memory']?.settings).toEqual({
      autoMemory: 'nope',
      maxSections: 'many',
    });
    expect(readMemorySettings(ws)).toEqual({ autoMemory: true, maxSections: 24 });

    setSettings([
      { op: 'replace', path: '/modules/core.memory/settings/maxSections', value: 0 },
      { op: 'replace', path: '/modules/core.memory/settings/autoMemory', value: false },
    ]);
    expect(readMemorySettings(ws)).toEqual({ autoMemory: false, maxSections: 24 });

    setSettings([{ op: 'replace', path: '/modules/core.memory/settings/maxSections', value: 3 }]);
    expect(readMemorySettings(ws)).toEqual({ autoMemory: false, maxSections: 3 }); // 合法值即时生效
  });
});
