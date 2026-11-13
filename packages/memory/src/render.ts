import type { MemorySection } from './views/memory-view.js';

/**
 * 常驻记忆渲染（注入层 T0）——把章节账本压成一段「越短越好、但绝不截断」的
 * markdown，供 System Prompt 常驻。
 *
 * 三层注入的分工（T1/T2 不在本文件）：
 *  - T0 常驻（本文件）：personal 全文 + project 目录（每节一行）；
 *  - T1 按需：模型调 memory.read(sectionKey) 取某节全文；
 *  - T2 预取：用户消息命中关键词 → server 直接注入 0–2 节全文（零 LLM 成本）。
 *
 * 预算纪律：两层都**超预算不截断**——只置标记，由调用方按层归并
 * （截断会让用户偏好随机失效，比多花 token 更糟）。
 * personalOverflow 只看用户画像；projectOverflow 只看业务约定目录。
 * 目录变长不再把个人层判成超预算。
 *
 * 预算是字符数而非 token：core.ai 的 provider 配置目前没有上下文窗口/num_ctx
 * 一项（packages/ai/src/provider/config.ts 只有 kind/baseUrl/apiKey/model），
 * 因此这里按保守换算硬编码（中文 ≈1 字符/token，1600 字符 ≈ 900 token 上限）。
 * 待补口子：将来 settings 暴露上下文窗口后，应改为按窗口比例计算。
 */

/** T0 常驻段总预算（字符） */
export const RESIDENT_CHAR_BUDGET = 1600;

/** personal 全文的行数预算（超出 = 需要归并，不截断） */
export const RESIDENT_PERSONAL_LINE_BUDGET = 40;

/** 渲染结果：text 为空串 = 无记忆（调用方整段跳过，不留空标记） */
export interface ResidentMemory {
  readonly text: string;
  /** 任一层超预算。界面上的「超预算」标记用这个 */
  readonly overflow: boolean;
  /** 用户画像全文超预算：归并 personal，不要去压项目目录 */
  readonly personalOverflow: boolean;
  /** 业务约定目录超预算：归并 project。目录再长也不截断 */
  readonly projectOverflow: boolean;
}

/** ISO 时间 → 相对时间（目录行的「更新于」，比绝对时间省 token 且更好读） */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '未知时间';
  const mins = Math.floor((now - t) / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return iso.slice(0, 10);
}

/** 目录行（T0 里 project 章节的唯一呈现；keywords 为空则省略该段） */
export function renderDirectoryLine(s: MemorySection, now: number = Date.now()): string {
  const lineCount = bodyLineCount(s.bodyMd);
  const parts = [`key=${s.sectionKey}`, `${lineCount} 行`];
  if (s.keywords.length > 0) parts.push(`关键词 ${s.keywords.join('/')}`);
  parts.push(`更新于 ${relativeTime(s.updatedAt, now)}`);
  const summary = s.summary.trim();
  return `- ${s.title}（${parts.join(' · ')}）${summary ? `：${summary}` : ''}`;
}

/** 正文章节渲染（T1/T2 取全文时的统一形状：小标题 + 正文） */
export function renderSectionBody(s: MemorySection): string {
  return `### ${s.title}\n${s.bodyMd.trim()}`;
}

/**
 * 渲染 T0 常驻段。
 * 章节序 = 投影的稳定序（scope 内按 created_at, section_key），两次渲染同库同序。
 */
export function renderResidentMemory(
  sections: readonly MemorySection[],
  now: number = Date.now(),
): ResidentMemory {
  const personal = sections.filter((s) => s.scope === 'personal');
  const project = sections.filter((s) => s.scope === 'project');
  const clear = { text: '', overflow: false, personalOverflow: false, projectOverflow: false };
  if (personal.length === 0 && project.length === 0) return clear;

  const lines: string[] = [];
  if (personal.length > 0) {
    lines.push('## 关于用户');
    for (const s of personal) lines.push(renderSectionBody(s), '');
    lines.pop(); // 去掉末节尾随空行
  }

  const personalText = lines.join('\n');
  const personalLines = personalText === '' ? 0 : personalText.split('\n').length;
  const personalOverflow =
    personalLines > RESIDENT_PERSONAL_LINE_BUDGET || personalText.length > RESIDENT_CHAR_BUDGET;

  const projectStart = lines.length;
  if (project.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `## 业务约定（${project.length} 节目录；需要某节全文时用 memory.read 传 sectionKey）`,
    );
    for (const s of project) lines.push(renderDirectoryLine(s, now));
  }
  const projectText = lines.slice(projectStart).join('\n');
  const projectOverflow = projectText.length > RESIDENT_CHAR_BUDGET;

  const text = lines.join('\n');
  return { text, overflow: personalOverflow || projectOverflow, personalOverflow, projectOverflow };
}

/** 正文字数（append 上限护栏与目录行「N 行」共用） */
export function bodyLineCount(bodyMd: string): number {
  const t = bodyMd.trim();
  return t === '' ? 0 : t.split('\n').length;
}
