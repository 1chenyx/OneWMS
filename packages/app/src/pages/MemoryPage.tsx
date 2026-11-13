import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  HistoryOutlined,
  PlusOutlined,
  SaveOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Collapse,
  Drawer,
  Empty,
  Input,
  InputNumber,
  List,
  Popconfirm,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { api, ApiError } from '../api/client';
import type {
  MemoryHistoryEntry,
  MemoryLedgerResponse,
  MemoryScope,
  MemorySection,
  MemorySettings,
} from '../api/client';
import { useAppNav } from '../app-nav';
import PageHeader from '../components/PageHeader';
import { LIST_PAGINATION } from '../components/table-style';

/**
 * AI 记忆管理页（章节级 markdown 账本的文档视图）。
 *
 * 记忆不再是一条条散句，而是一篇篇有标题/摘要/关键词的 markdown 章节：
 *  - 读：GET /api/memory 一次拿全「章节清单 + 生效设置 + AI 常驻段 T0」；
 *  - 写：追加一行（memory.append）/ 整节改写（memory.rewrite）/ 删节
 *    （memory.remove）都走工具总线——护栏、审计、多节点同步免费；
 *  - 并发：改写与删除必须回传章节的 baseLamport 作乐观令牌，被人抢先写过
 *    就冲突（此时提示 + 自动刷新，旧令牌不可能再写成功）；
 *  - 整理：consolidate 让大模型把散乱章节拆分归并（十几秒，故全程 loading）；
 *  - 设置：autoMemory / maxSections 改动走慢通道（提议 → 人工确认），
 *    与助手定义同一条通道——配置变更铁律。
 */

/** v1 条目式记忆的收容章节键（server 端 LEGACY_SECTION_KEY 的镜像） */
const LEGACY_KEYS = new Set(['legacy-personal', 'legacy-project']);

const SCOPE_META: Record<MemoryScope, { title: string; hint: string }> = {
  personal: {
    title: '关于用户',
    hint: '称呼、习惯、偏好——AI 常驻看全文，是「懂你」的底料',
  },
  project: {
    title: '业务约定',
    hint: '商品特性、供应商、流程口径——常驻只放目录，AI 按需取全文',
  },
};

const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** 正文/常驻段的呈现：等宽 + 保留换行 + 限高滚动（不引 markdown 渲染依赖） */
const PRE_STYLE: CSSProperties = {
  margin: 0,
  padding: 8,
  background: '#fafafa',
  borderRadius: 6,
  fontFamily: MONO_FONT,
  fontSize: 12,
  lineHeight: 1.7,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 220,
  overflow: 'auto',
};

/** 章节的自然身份（追加输入框草稿、loading 都按它索引；id 会随重写变化） */
const sid = (s: { scope: MemoryScope; sectionKey: string }) => `${s.scope}:${s.sectionKey}`;

/**
 * ISO → 相对时间。@one/memory 里有同规则实现，但前端不引服务端运行时
 * （SQLite / node:crypto 都进不了浏览器），只能镜像一份。
 */
function relativeTime(iso: string, now = Date.now()): string {
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

/**
 * 并发冲突判定：护栏拒绝统一是 TOOL_REJECTED，其中「令牌期望 X，实到 Y」这类
 * 消息意味着章节已被别的写入更新——只能刷新重来，重试同一份草稿必再失败。
 */
function isLamportConflict(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return text.includes('令牌') || text.includes('amport') || text.includes('已被其他写入更新');
}

/** 加载失败时的兜底空账本（错误已单独提示；设置回代码缺省，界面仍可操作） */
const EMPTY_LEDGER: MemoryLedgerResponse = {
  sections: [],
  settings: { autoMemory: true, maxSections: 24 },
  resident: { text: '', overflow: false, personalOverflow: false, projectOverflow: false },
};

export default function MemoryPage() {
  const { message } = AntApp.useApp();
  const { navigate } = useAppNav();
  const [loading, setLoading] = useState(true);
  const [ledger, setLedger] = useState<MemoryLedgerResponse | null>(null);
  const [draft, setDraft] = useState<MemorySettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [consolidating, setConsolidating] = useState(false);
  const [residentKeys, setResidentKeys] = useState<string[]>([]);
  // 卡片内「追加一行」的草稿与忙碌态（按章节自然键索引，互不干扰）
  const [appendDraft, setAppendDraft] = useState<Record<string, string>>({});
  const [appendBusy, setAppendBusy] = useState<string | null>(null);
  // 编辑抽屉
  const [editing, setEditing] = useState<MemorySection | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editKeywords, setEditKeywords] = useState<string[]>([]);
  const [keywordInput, setKeywordInput] = useState('');
  const [savingSection, setSavingSection] = useState(false);
  // 历史抽屉
  const [historyFor, setHistoryFor] = useState<MemorySection | null>(null);
  const [history, setHistory] = useState<MemoryHistoryEntry[] | null>(null);
  const [rollbackLamport, setRollbackLamport] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await api.memoryLedger();
      setLedger(data);
      setDraft(data.settings);
    } catch (e) {
      message.error(`记忆加载失败：${e instanceof Error ? e.message : String(e)}`);
      setLedger(EMPTY_LEDGER);
      setDraft(EMPTY_LEDGER.settings);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 写失败的统一出口：冲突 → 提示 + 自动刷新（并关掉握着旧令牌的抽屉）；其余原样报错 */
  const fail = useCallback(
    async (e: unknown, prefix: string) => {
      if (isLamportConflict(e)) {
        message.warning('记忆已被更新，正在刷新最新内容');
        setEditing(null);
        setHistoryFor(null);
        await reload();
        return;
      }
      const text = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
      message.error(`${prefix}：${text}`);
    },
    [message, reload],
  );

  const sections = ledger?.sections ?? [];
  const resident = ledger?.resident ?? {
    text: '',
    overflow: false,
    personalOverflow: false,
    projectOverflow: false,
  };
  const hasLegacy = sections.some((s) => LEGACY_KEYS.has(s.sectionKey));

  /** 追加一行要点（不需要令牌：追加天然可交换，护栏只管长度与章节数） */
  const append = async (s: MemorySection) => {
    const key = sid(s);
    const text = (appendDraft[key] ?? '').trim();
    if (!text) {
      message.error('先输入要追加的要点');
      return;
    }
    setAppendBusy(key);
    try {
      await api.appendMemory({ scope: s.scope, sectionKey: s.sectionKey, title: s.title, text });
      message.success(`已追加到「${s.title}」`);
      setAppendDraft((prev) => ({ ...prev, [key]: '' }));
      await reload();
    } catch (e) {
      await fail(e, '追加失败');
    } finally {
      setAppendBusy(null);
    }
  };

  const removeSection = async (s: MemorySection) => {
    try {
      await api.removeMemory({ scope: s.scope, sectionKey: s.sectionKey, baseLamport: s.baseLamport });
      message.success(`已删除「${s.title}」`);
      await reload();
    } catch (e) {
      await fail(e, '删除失败');
    }
  };

  const openEditor = (s: MemorySection) => {
    setEditing(s);
    setEditTitle(s.title);
    setEditSummary(s.summary);
    setEditBody(s.bodyMd);
    setEditKeywords([...s.keywords]);
    setKeywordInput('');
  };

  /** 关键词：小写归一（与 server 的章节键/关键词习惯一致）、去重、≤8 个 */
  const addKeyword = () => {
    const k = keywordInput.trim().toLowerCase();
    setKeywordInput('');
    if (!k) return;
    setEditKeywords((prev) => (prev.includes(k) || prev.length >= 8 ? prev : [...prev, k]));
  };

  const saveEditor = async () => {
    if (!editing) return;
    const title = editTitle.trim();
    const bodyMd = editBody.trim();
    if (!title) {
      message.error('标题不能为空');
      return;
    }
    if (!bodyMd) {
      message.error('正文不能为空——要清空整节请用卡片上的「删除」');
      return;
    }
    setSavingSection(true);
    try {
      await api.rewriteMemory({
        scope: editing.scope,
        sectionKey: editing.sectionKey,
        title,
        bodyMd,
        summary: editSummary.trim(),
        keywords: editKeywords,
        baseLamport: editing.baseLamport,
      });
      message.success(`已保存「${title}」`);
      setEditing(null);
      await reload();
    } catch (e) {
      await fail(e, '保存失败');
    } finally {
      setSavingSection(false);
    }
  };

  const openHistory = async (s: MemorySection) => {
    setHistoryFor(s);
    setHistory(null);
    try {
      const res = await api.memoryHistory(s.scope, s.sectionKey);
      setHistory(res.entries);
    } catch (e) {
      message.error(`历史加载失败：${e instanceof ApiError ? e.message : String(e)}`);
      setHistory([]);
    }
  };

  /**
   * 回滚 = 用历史版本的正文调一次 rewrite，但令牌取「当前章节」的 baseLamport。
   * 历史版本的 lamport 早已过期，拿它提交必被护栏拒绝。
   */
  const rollback = async (entry: MemoryHistoryEntry) => {
    if (!historyFor) return;
    const current =
      sections.find((s) => s.scope === historyFor.scope && s.sectionKey === historyFor.sectionKey) ??
      historyFor;
    setRollbackLamport(entry.lamport);
    try {
      await api.rewriteMemory({
        scope: current.scope,
        sectionKey: current.sectionKey,
        title: entry.title,
        bodyMd: entry.bodyMd,
        summary: entry.summary,
        keywords: entry.keywords,
        baseLamport: current.baseLamport,
      });
      message.success(`已回滚到 ${relativeTime(entry.createdAt)} 的版本`);
      setHistoryFor(null);
      await reload();
    } catch (e) {
      await fail(e, '回滚失败');
    } finally {
      setRollbackLamport(null);
    }
  };

  /** 整理：调大模型拆分归并，十几秒量级——期间禁用其他写入口，避免令牌互相打架 */
  const consolidate = async () => {
    setConsolidating(true);
    try {
      const res = await api.consolidateMemory();
      const total = res.scopes.reduce(
        (acc, s) => ({
          rewritten: acc.rewritten + s.rewritten,
          created: acc.created + s.created,
          removed: acc.removed + s.removed,
          deferred: acc.deferred + s.deferred,
          failed: [...acc.failed, ...s.failed.map((f) => `${f.sectionKey}（${f.message}）`)],
        }),
        { rewritten: 0, created: 0, removed: 0, deferred: 0, failed: [] as string[] },
      );
      const deferred = total.deferred > 0 ? `，另有 ${total.deferred} 节留到下次` : '';
      message.success(
        `整理完成：改写 ${total.rewritten} 节 / 新建 ${total.created} 节 / 删除 ${total.removed} 节${deferred}`,
        6,
      );
      if (total.failed.length > 0) {
        message.warning(`以下章节未能归并：${total.failed.join('；')}`, 10);
      }
      await reload();
    } catch (e) {
      message.error(`整理失败：${e instanceof ApiError ? e.message : String(e)}`);
    } finally {
      setConsolidating(false);
    }
  };

  /** 导出 .md：浏览器原生下载（Blob + a[download]），不引第三方库 */
  const exportMd = () => {
    if (sections.length === 0) {
      message.info('暂无章节可导出');
      return;
    }
    const md =
      sections
        .map(
          (s) =>
            `## [${s.scope}] ${s.title}\n<!-- key: ${s.sectionKey} -->\n\n${s.bodyMd.trim()}`,
        )
        .join('\n\n') + '\n';
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `onewms-memory-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    message.success(`已导出 ${sections.length} 节`);
  };

  /** 设置走慢通道：只提改动过的键，提交后到「AI 对话」页的确认弹窗拍板 */
  const saveSettings = async () => {
    if (!ledger || !draft) return;
    const changed: { autoMemory?: boolean; maxSections?: number } = {};
    if (draft.autoMemory !== ledger.settings.autoMemory) changed.autoMemory = draft.autoMemory;
    if (draft.maxSections !== ledger.settings.maxSections) changed.maxSections = draft.maxSections;
    if (Object.keys(changed).length === 0) {
      message.info('设置未变化');
      return;
    }
    setSavingSettings(true);
    try {
      await api.proposeMemorySettings(changed, '更新 AI 记忆设置');
      message.success('已生成设置提议——需人工确认后生效，请到「AI 对话」页的确认窗口拍板');
      navigate('chat');
    } catch (e) {
      message.error(
        `提交失败：${e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setSavingSettings(false);
    }
  };

  const renderScope = (scope: MemoryScope) => {
    const list = sections.filter((s) => s.scope === scope);
    const meta = SCOPE_META[scope];
    return (
      <Card
        key={scope}
        title={
          <Space size={8}>
            <span>{meta.title}</span>
            <Tag>{list.length} 节</Tag>
          </Space>
        }
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {meta.hint}
          </Typography.Text>
        }
      >
        {list.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="暂无章节——与 AI 对话后会自动积累"
          />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
              gap: 12,
              alignItems: 'start',
            }}
          >
            {list.map((s) => (
              <SectionCard
                key={sid(s)}
                section={s}
                appendValue={appendDraft[sid(s)] ?? ''}
                appendBusy={appendBusy === sid(s)}
                disabled={consolidating}
                onAppendChange={(v) => setAppendDraft((prev) => ({ ...prev, [sid(s)]: v }))}
                onAppend={() => void append(s)}
                onEdit={openEditor}
                onHistory={(t) => void openHistory(t)}
                onDelete={(t) => void removeSection(t)}
              />
            ))}
          </div>
        )}
      </Card>
    );
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        flex: 1,
        minHeight: 0,
        width: '100%',
      }}
    >
      <PageHeader
        title="AI 记忆"
        subtitle="章节级 markdown 账本：AI 记住的用户偏好与业务约定，可追加、改写、回滚、整理"
        extra={
          <>
            <Button
              icon={<DownloadOutlined />}
              disabled={consolidating || sections.length === 0}
              onClick={exportMd}
            >
              导出 .md
            </Button>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={consolidating}
              onClick={() => void consolidate()}
            >
              整理
            </Button>
          </>
        }
      />

      {hasLegacy ? (
        <Alert
          type="info"
          showIcon
          message="v1 条目式记忆已迁入收容章节，点「整理」让 AI 拆分归并到正式章节，或在编辑器里人工处理后删除本节"
        />
      ) : null}

      <Card size="small">
        <Space size="large" wrap>
          <Space size="small">
            <Typography.Text>对话后自动提取记忆</Typography.Text>
            <Switch
              checked={draft?.autoMemory ?? true}
              disabled={consolidating}
              onChange={(v) => setDraft((s) => (s ? { ...s, autoMemory: v } : s))}
            />
          </Space>
          <Space size="small">
            <Typography.Text>章节上限</Typography.Text>
            <InputNumber
              min={1}
              max={200}
              value={draft?.maxSections ?? 24}
              disabled={consolidating}
              onChange={(v) => setDraft((s) => (s ? { ...s, maxSections: v ?? 24 } : s))}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              节（达到后拒绝新建章节，仍可写既有章节）
            </Typography.Text>
          </Space>
          <Button
            icon={<SaveOutlined />}
            loading={savingSettings}
            disabled={consolidating}
            onClick={() => void saveSettings()}
          >
            保存设置（生成提议）
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            设置改动走慢通道：提交后在「AI 对话」页弹出确认，拍板才生效。
          </Typography.Text>
        </Space>
      </Card>

      <Card size="small" styles={{ body: { padding: '4px 12px' } }}>
        <Collapse
          ghost
          activeKey={residentKeys}
          onChange={(k) => setResidentKeys(k as string[])}
          items={[
            {
              key: 'resident',
              label: (
                <Space size={8} wrap>
                  <Typography.Text strong>AI 每轮对话常驻看到的记忆（T0）</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {resident.text.length} 字符 · 关于用户全文 + 业务约定目录
                  </Typography.Text>
                  {resident.overflow ? <Tag color="warning">超预算</Tag> : null}
                </Space>
              ),
              children: (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {resident.personalOverflow ? (
                    <Alert type="warning" showIcon message="用户画像已超预算，建议点「整理」压缩" />
                  ) : null}
                  {resident.projectOverflow ? (
                    <Alert type="warning" showIcon message="业务约定目录已超预算，建议点「整理」压缩" />
                  ) : null}
                  <pre style={{ ...PRE_STYLE, maxHeight: 360 }}>
                    {resident.text.trim() || '（暂无常驻记忆——积累章节后这里会显示 AI 实际读到的文本）'}
                  </pre>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      {loading ? (
        <Card loading />
      ) : (
        <>
          {renderScope('personal')}
          {renderScope('project')}
        </>
      )}

      <Drawer
        title={
          <Space size={8}>
            <span>编辑章节</span>
            {editing ? <Typography.Text code>{editing.sectionKey}</Typography.Text> : null}
          </Space>
        }
        width={720}
        open={editing !== null}
        onClose={() => setEditing(null)}
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              baseLamport {editing?.baseLamport ?? '—'}（并发令牌，提交时原样回传；不符即冲突）
            </Typography.Text>
            <Space>
              <Button onClick={() => setEditing(null)}>取消</Button>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={savingSection}
                onClick={() => void saveEditor()}
              >
                保存
              </Button>
            </Space>
          </div>
        }
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div>
            <Typography.Text type="secondary">标题（常驻目录与正文小标题都用它）</Typography.Text>
            <Input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              placeholder="如 SKU 特性与搬运要求"
              maxLength={60}
            />
          </div>
          <div>
            <Typography.Text type="secondary">摘要（一句话，业务约定层只把它放进常驻目录）</Typography.Text>
            <Input
              value={editSummary}
              onChange={(e) => setEditSummary(e.target.value)}
              placeholder="如 A001 易碎、冷链商品需先入库后贴标"
              maxLength={120}
            />
          </div>
          <div>
            <Typography.Text type="secondary">关键词（AI 按需预取的判据，≤8 个，回车添加）</Typography.Text>
            <div style={{ marginTop: 4 }}>
              <Space size={4} wrap>
                {editKeywords.map((k) => (
                  <Tag
                    key={k}
                    color="blue"
                    closable
                    onClose={(e) => {
                      e.preventDefault(); // 由 state 决定去留，别让 antd 自己摘掉标签
                      setEditKeywords((prev) => prev.filter((x) => x !== k));
                    }}
                  >
                    {k}
                  </Tag>
                ))}
                {editKeywords.length < 8 ? (
                  <Input
                    size="small"
                    style={{ width: 150 }}
                    value={keywordInput}
                    placeholder="如 易碎 / A001"
                    onChange={(e) => setKeywordInput(e.target.value)}
                    onPressEnter={addKeyword}
                    onBlur={addKeyword}
                  />
                ) : null}
              </Space>
            </div>
          </div>
          <div>
            <Typography.Text type="secondary">正文（markdown，一行一个要点）</Typography.Text>
            <Input.TextArea
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              autoSize={{ minRows: 12, maxRows: 28 }}
              style={{ fontFamily: MONO_FONT, fontSize: 13, lineHeight: 1.7 }}
            />
          </div>
        </Space>
      </Drawer>

      <Drawer
        title={
          <Space size={8}>
            <span>历史版本</span>
            {historyFor ? <Typography.Text code>{historyFor.sectionKey}</Typography.Text> : null}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              最新在前，最多 50 条
            </Typography.Text>
          </Space>
        }
        width={680}
        open={historyFor !== null}
        onClose={() => setHistoryFor(null)}
      >
        {history === null ? (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <Spin />
          </div>
        ) : history.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无历史版本" />
        ) : (
          <List
            dataSource={history}
            pagination={LIST_PAGINATION}
            renderItem={(h) => (
              <List.Item
                actions={[
                  <Button
                    key="rollback"
                    size="small"
                    loading={rollbackLamport === h.lamport}
                    onClick={() => void rollback(h)}
                  >
                    回滚到此版本
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space size={6} wrap>
                      <Tag>{h.type}</Tag>
                      <Typography.Text title={new Date(h.createdAt).toLocaleString()}>
                        {relativeTime(h.createdAt)}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {h.actor} · lamport {h.lamport}
                      </Typography.Text>
                    </Space>
                  }
                  description={
                    <div>
                      <Space size={6} wrap>
                        <Typography.Text strong>{h.title}</Typography.Text>
                        {h.summary ? (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {h.summary}
                          </Typography.Text>
                        ) : null}
                      </Space>
                      <pre style={{ ...PRE_STYLE, maxHeight: 140, marginTop: 6 }}>
                        {h.bodyMd.trim() || '（空正文）'}
                      </pre>
                    </div>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Drawer>
    </div>
  );
}

/**
 * 单节卡片 = 文档视图的最小单元：标题 + 键 + 摘要 + 关键词 + 正文预览，
 * 以及「追加一行」这条最常用的轻量写入（不必进编辑器就能记一句）。
 * legacy-* 收容章节加左侧警示条，提醒它是 v1 迁移过来的待归并内容。
 */
function SectionCard({
  section,
  appendValue,
  appendBusy,
  disabled,
  onAppendChange,
  onAppend,
  onEdit,
  onHistory,
  onDelete,
}: {
  section: MemorySection;
  appendValue: string;
  appendBusy: boolean;
  disabled: boolean;
  onAppendChange: (value: string) => void;
  onAppend: () => void;
  onEdit: (s: MemorySection) => void;
  onHistory: (s: MemorySection) => void;
  onDelete: (s: MemorySection) => void;
}) {
  const legacy = LEGACY_KEYS.has(section.sectionKey);
  return (
    <Card
      size="small"
      style={legacy ? { borderLeft: '3px solid #faad14' } : undefined}
      title={
        <Space size={6} wrap>
          <Typography.Text strong>{section.title || section.sectionKey}</Typography.Text>
          {legacy ? <Tag color="orange">v1 收容</Tag> : null}
        </Space>
      }
      extra={
        <Space size={0}>
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            disabled={disabled}
            onClick={() => onEdit(section)}
          >
            编辑
          </Button>
          <Button
            type="text"
            size="small"
            icon={<HistoryOutlined />}
            onClick={() => onHistory(section)}
          >
            历史
          </Button>
          <Popconfirm
            title="删除整节？"
            description={`「${section.title}」的全部要点都会从记忆里消失（可从历史版本回滚前请先确认）`}
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => onDelete(section)}
          >
            <Button type="text" size="small" danger icon={<DeleteOutlined />} disabled={disabled}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      }
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space size={6} wrap>
          <Typography.Text code style={{ fontSize: 12 }}>
            {section.sectionKey}
          </Typography.Text>
          <Tag>{section.lines} 行</Tag>
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12 }}
            title={new Date(section.updatedAt).toLocaleString()}
          >
            更新于 {relativeTime(section.updatedAt)} · {section.lastActor}
          </Typography.Text>
        </Space>
        {section.summary ? (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 13 }}>
            {section.summary}
          </Typography.Paragraph>
        ) : null}
        {section.keywords.length > 0 ? (
          <Space size={4} wrap>
            {section.keywords.map((k) => (
              <Tag key={k} color="blue">
                {k}
              </Tag>
            ))}
          </Space>
        ) : null}
        <pre style={PRE_STYLE}>{section.bodyMd.trim() || '（空正文）'}</pre>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            size="small"
            placeholder="追加一行要点，回车即写"
            value={appendValue}
            disabled={disabled || appendBusy}
            onChange={(e) => onAppendChange(e.target.value)}
            onPressEnter={onAppend}
          />
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            loading={appendBusy}
            disabled={disabled}
            onClick={onAppend}
          >
            追加
          </Button>
        </Space.Compact>
      </Space>
    </Card>
  );
}
