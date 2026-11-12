import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { DeleteOutlined, ExclamationCircleOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Popover,
  Switch,
  Tag,
  Tooltip,
} from 'antd';
import { api, ApiError } from '../api/client';
import type { AgentDef } from '../api/client';
import AgentApplyConfirm from '../components/AgentApplyConfirm';
import PageHeader from '../components/PageHeader';
import {
  MISSING_TOOLS,
  agentChangeLines,
  agentSnapshot,
  applyGroupLevel,
  applyToolIds,
  assistantSummary,
  buildBuckets,
  groupChoices,
  groupHint,
  groupLevel,
  levelDetail,
  levelTitle,
  type AgentToolInfo,
  type ToolBucket,
} from './agent-tools';

/**
 * AI 助手管理。左边是助手清单，右边是当前助手的详情。
 * 详情里先看每块业务的现状，点开一块再改：不开放、只能查询或可以修改。
 * 具体工具在感叹号上，悬停才出现。
 * 保存后在本页确认才写入。助手改动不进对话页的配置确认。
 */

interface Draft {
  key: string;
  persisted: boolean;
  def: AgentDef;
}

function emptyDef(): AgentDef {
  return { id: '', name: '', description: '', systemPrompt: '', tools: [] };
}

const PAGE_HINT =
  '左边选助手，右边点一块业务来改它能做什么。保存后在本页确认，才会生效。清单清空再保存，会恢复内置的通用、只读、配置。';

const PAGE_STYLE = `
.agents-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  height: 100%;
  max-height: 100%;
  min-height: 0;
  overflow: hidden;
}
.agents-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.agents-split {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  gap: 12px;
}
.agents-list.ant-card,
.agents-detail.ant-card {
  height: 100%;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.agents-list > .ant-card-body,
.agents-detail > .ant-card-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: hidden;
  padding: 12px;
}
.agents-list-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.agents-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  margin: 0 0 8px;
  padding: 8px 10px;
  text-align: left;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  background: #fff;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.agents-item:last-child { margin-bottom: 0; }
.agents-item:hover { border-color: var(--line-strong); }
.agents-item.is-selected {
  border-color: var(--line);
  background: var(--raised);
  box-shadow: inset 3px 0 0 var(--amber);
}
.agents-item-name {
  font-weight: 500;
  line-height: 1.4;
  word-break: break-word;
}
.agents-item-meta {
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  line-height: 1.4;
}
.agents-identity {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}
.agents-id { width: 148px; flex: none; }
.agents-name { width: 160px; flex: none; }
.agents-desc { flex: 1; min-width: 120px; }
.agents-detail-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.agents-section { flex: none; font-weight: 500; }
.agents-areas {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
  align-content: start;
}
.agents-area { position: relative; }
.agents-area-hit,
.agents-choice {
  margin: 0;
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
  background: #fff;
  border: 1px solid #f0f0f0;
  border-radius: 12px;
}
.agents-area-hit {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 6px;
  width: 100%;
  min-height: 84px;
  padding: 12px 28px 12px 12px;
}
.agents-area-hit:hover,
.agents-choice:hover { border-color: var(--line-strong); }
.agents-area.is-off { box-shadow: inset 3px 0 0 #d4d4d4; }
.agents-area.is-read { box-shadow: inset 3px 0 0 var(--ink); }
.agents-area.is-write { box-shadow: inset 3px 0 0 var(--good); }
.agents-area.is-custom { box-shadow: inset 3px 0 0 var(--amber); }
.agents-area-name { font-weight: 500; }
.agents-area-status { font-size: 16px; font-weight: 500; }
.agents-area.is-off .agents-area-status { color: rgba(0, 0, 0, 0.45); }
.agents-area.is-read .agents-area-status { color: var(--ink); }
.agents-area.is-write .agents-area-status { color: var(--good); }
.agents-area.is-custom .agents-area-status { color: var(--amber-ink); }
.agents-area .agents-hint {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 1;
}
.agents-question {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 18px;
  font-weight: 500;
}
.agents-custom { flex: none; color: var(--amber-ink); }
.agents-choices {
  flex: none;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.agents-choice {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  min-height: 112px;
  padding: 16px;
}
.agents-choice-title { font-size: 20px; font-weight: 500; }
.agents-choice-detail {
  color: rgba(0, 0, 0, 0.65);
  font-size: 14px;
  font-weight: 400;
  line-height: 1.5;
}
.agents-choice[data-level='read'] .agents-choice-title { color: var(--ink); }
.agents-choice[data-level='write'] .agents-choice-title { color: var(--good); }
.agents-choice.is-selected[data-level='off'] {
  border-color: var(--line);
  background: var(--raised);
  box-shadow: inset 3px 0 0 #d4d4d4;
}
.agents-choice.is-selected[data-level='read'] {
  border-color: var(--line);
  background: var(--raised);
  box-shadow: inset 3px 0 0 var(--ink);
}
.agents-choice.is-selected[data-level='write'] {
  border-color: var(--line);
  background: var(--raised);
  box-shadow: inset 3px 0 0 var(--good);
}
.agents-tools {
  flex: none;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
}
.agents-tool {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
}
.agents-missing {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  color: var(--amber-ink);
}
.agents-field-label {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
}
.agents-more { width: 280px; display: flex; flex-direction: column; gap: 10px; }
.agents-persona { width: 420px; }
.agents-hint {
  display: inline-flex;
  align-items: center;
  flex: none;
  color: rgba(0, 0, 0, 0.45);
  cursor: help;
  font-size: 14px;
}
.agents-item:focus-visible,
.agents-area-hit:focus-visible,
.agents-choice:focus-visible,
.agents-hint:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 1px;
}
@media (max-width: 960px) {
  .agents-split { grid-template-columns: 168px minmax(0, 1fr); }
  .agents-identity { flex-wrap: wrap; }
  .agents-persona { width: min(420px, 80vw); }
}
`;

function Hint({ text }: { text: string }) {
  return (
    <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{text}</span>}>
      <span className="agents-hint" tabIndex={0} aria-label={text}>
        <ExclamationCircleOutlined />
      </span>
    </Tooltip>
  );
}

function FieldLabel({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="agents-field-label">
      <span>{label}</span>
      <Hint text={hint} />
    </div>
  );
}

function AreaGrid({
  buckets,
  granted,
  onOpen,
  onDropMissing,
}: {
  buckets: ToolBucket[];
  granted: string[];
  onOpen: (areaId: string) => void;
  onDropMissing: (ids: string[]) => void;
}) {
  const missing = buckets.find((bucket) => bucket.id === MISSING_TOOLS) ?? null;
  return (
    <>
      <div className="agents-section">能做什么</div>
      <div className="agents-areas">
        {buckets
          .filter((bucket) => bucket.id !== MISSING_TOOLS)
          .map((bucket) => {
            const level = groupLevel(bucket.tools, granted);
            const title = levelTitle(level, bucket.id);
            const hint = groupHint(bucket);
            return (
              <div key={bucket.id} className={`agents-area is-${level}`}>
                <button
                  type="button"
                  className="agents-area-hit"
                  aria-label={`${bucket.label}，${title}`}
                  onClick={() => onOpen(bucket.id)}
                >
                  <span className="agents-area-name">{bucket.label}</span>
                  <span className="agents-area-status">{title}</span>
                </button>
                {hint ? <Hint text={hint} /> : null}
              </div>
            );
          })}
      </div>
      {missing ? (
        <div className="agents-missing">
          <span>{missing.tools.length} 项授权已失效</span>
          <Hint text={missing.tools.map((tool) => tool.label).join('\n')} />
          <Button type="link" size="small" onClick={() => onDropMissing(missing.tools.map((tool) => tool.id))}>
            去掉
          </Button>
        </div>
      ) : null}
    </>
  );
}

function AreaPanel({
  bucket,
  granted,
  onChange,
}: {
  bucket: ToolBucket;
  granted: string[];
  onChange: (tools: string[]) => void;
}) {
  const [fine, setFine] = useState(false);
  const level = groupLevel(bucket.tools, granted);
  const hint = groupHint(bucket);
  return (
    <>
      <div className="agents-question">
        <span>这个助手怎么处理{bucket.label}？</span>
        {hint ? <Hint text={hint} /> : null}
      </div>
      {level === 'custom' ? (
        <div className="agents-custom">现在是单独调整。点下面某一档，会按整档重新设置。</div>
      ) : null}
      <div className="agents-choices">
        {groupChoices(bucket).map((choice) => {
          const selected = level === choice.value;
          return (
            <button
              key={choice.value}
              type="button"
              className={selected ? 'agents-choice is-selected' : 'agents-choice'}
              data-level={choice.value}
              aria-pressed={selected}
              aria-label={choice.label}
              onClick={() => onChange(applyGroupLevel(granted, bucket.tools, choice.value))}
            >
              <span className="agents-choice-title">{choice.label}</span>
              <span className="agents-choice-detail">{levelDetail(bucket, choice.value)}</span>
            </button>
          );
        })}
      </div>
      <div>
        <Button type="link" aria-expanded={fine} onClick={() => setFine((open) => !open)} style={{ paddingInline: 0 }}>
          逐项调整
        </Button>
      </div>
      {fine ? (
        <div className="agents-tools">
          {bucket.tools.map((tool) => (
            <div key={tool.id} className="agents-tool">
              <Switch
                aria-label={tool.label}
                checked={granted.includes(tool.id)}
                onChange={(checked) => onChange(applyToolIds(granted, [tool.id], checked))}
              />
              <span>{tool.label}</span>
              <Tag color={tool.permission === 'write' ? 'orange' : 'blue'}>
                {tool.permission === 'write' ? '写入' : '只读'}
              </Tag>
              {tool.description ? <Hint text={tool.description} /> : null}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

export default function AgentsPage() {
  const { message } = AntApp.useApp();
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [tools, setTools] = useState<AgentToolInfo[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [areaId, setAreaId] = useState<string | null>(null);
  const [baseline, setBaseline] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const seq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api
      .agents()
      .then((catalog) => {
        if (!alive) return;
        const loaded = catalog.agents.map((agent) => ({
          key: agent.id,
          persisted: agent.id.trim() !== '',
          def: agent,
        }));
        setDrafts(loaded);
        setTools(catalog.tools);
        setActiveKey(loaded[0]?.key ?? null);
        setBaseline(agentSnapshot(loaded.map((draft) => draft.def)));
      })
      .catch((e) => {
        if (!alive) return;
        setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const patchActive = (patch: Partial<AgentDef>) => {
    setDrafts((prev) =>
      prev!.map((draft) =>
        draft.key === activeKey ? { ...draft, def: { ...draft.def, ...patch } } : draft,
      ),
    );
  };

  const selectAgent = (key: string) => {
    setActiveKey(key);
    setAreaId(null);
  };

  const createAgent = () => {
    seq.current += 1;
    const key = `draft-${seq.current}`;
    const draft: Draft = { key, persisted: false, def: emptyDef() };
    setDrafts((prev) => [draft, ...prev!]);
    setActiveKey(key);
    setAreaId(null);
    listRef.current?.scrollTo({ top: 0 });
  };

  const removeAgent = () => {
    if (!drafts) return;
    const index = drafts.findIndex((draft) => draft.key === activeKey);
    const next = drafts.filter((draft) => draft.key !== activeKey);
    setDrafts(next);
    setActiveKey(next[Math.min(index, next.length - 1)]?.key ?? null);
    setAreaId(null);
  };

  const save = async () => {
    if (!drafts) return;
    const seen = new Set<string>();
    for (const draft of drafts) {
      const agent = draft.def;
      const invalid =
        !agent.id.trim() ||
        !agent.name.trim() ||
        typeof agent.systemPrompt !== 'string' ||
        !Array.isArray(agent.tools);
      if (invalid) {
        setActiveKey(draft.key);
        setAreaId(null);
        message.error(`助手「${agent.name.trim() || agent.id.trim() || '未命名'}」缺少必填项（id、名称）`);
        return;
      }
      if (seen.has(agent.id)) {
        setActiveKey(draft.key);
        setAreaId(null);
        message.error(`助手 id 重复：${agent.id}`);
        return;
      }
      seen.add(agent.id);
    }
    const submitting = drafts.map((draft) => draft.def);
    setSaving(true);
    try {
      if (pendingId) {
        const previous = pendingId;
        setPendingId(null);
        setConfirmOpen(false);
        try {
          await api.rejectProposal(previous);
        } catch {
          // 上一次提议可能已经过期，不影响这次重新保存。
        }
      }
      const { proposalId } = await api.proposeAgents(submitting, '更新 AI 助手定义');
      setPendingId(proposalId);
      setConfirmOpen(true);
    } catch (e) {
      message.error(
        e instanceof ApiError ? e.message : `提交失败：${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setSaving(false);
    }
  };

  const applyPending = async () => {
    if (!pendingId || !drafts) return;
    setApplying(true);
    try {
      const result = await api.confirmProposal(pendingId);
      const submitted = drafts.map((draft) => draft.def);
      setDrafts((prev) =>
        prev!.map((draft) => ({ ...draft, persisted: draft.def.id.trim() !== '' })),
      );
      setBaseline(agentSnapshot(submitted));
      setPendingId(null);
      setConfirmOpen(false);
      message.success(`助手改动已应用（配置版本 v${result.newVersion}）`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PROPOSAL_STALE') {
        message.warning('这次改动已经过期，请再保存一次。');
        setPendingId(null);
        setConfirmOpen(false);
      } else {
        message.error(
          e instanceof ApiError ? e.message : `应用失败：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } finally {
      setApplying(false);
    }
  };

  const discardPending = async () => {
    if (!pendingId) return;
    setDiscarding(true);
    try {
      await api.rejectProposal(pendingId);
      setPendingId(null);
      setConfirmOpen(false);
      message.info('已放弃这次助手改动，当前配置没有变。');
    } catch (e) {
      message.error(
        e instanceof ApiError ? e.message : `放弃失败：${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setDiscarding(false);
    }
  };

  const header = (extra?: ReactNode) => (
    <PageHeader
      title={
        <span className="agents-title">
          助手管理
          <Hint text={PAGE_HINT} />
        </span>
      }
      extra={extra}
    />
  );

  if (loadError) {
    return (
      <div className="agents-page app-fill">
        <style>{PAGE_STYLE}</style>
        {header(
          <>
            <Button icon={<PlusOutlined />} disabled>
              新建助手
            </Button>
            <Button type="primary" icon={<SaveOutlined />} disabled>
              保存（生成提议）
            </Button>
          </>,
        )}
        <Alert type="error" showIcon message="助手清单加载失败" description={loadError} />
      </div>
    );
  }

  if (drafts === null) {
    return (
      <div className="agents-page app-fill">
        <style>{PAGE_STYLE}</style>
        {header()}
        <Card loading />
      </div>
    );
  }

  const active = drafts.find((draft) => draft.key === activeKey) ?? null;
  const dirty = agentSnapshot(drafts.map((draft) => draft.def)) !== baseline;
  const changeLines = agentChangeLines(
    baseline ? (JSON.parse(baseline) as AgentDef[]) : [],
    drafts.map((draft) => draft.def),
    tools,
  );
  const buckets = buildBuckets(tools, active?.def.tools ?? []);
  const area = areaId ? (buckets.find((bucket) => bucket.id === areaId) ?? null) : null;

  return (
    <div className="agents-page app-fill">
      <style>{PAGE_STYLE}</style>
      {header(
        <>
          {dirty ? <Tag color="gold">未保存</Tag> : null}
          {pendingId && !confirmOpen ? (
            <Button onClick={() => setConfirmOpen(true)}>确认助手改动</Button>
          ) : null}
          <Button icon={<PlusOutlined />} disabled={saving} onClick={createAgent}>
            新建助手
          </Button>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
            保存（生成提议）
          </Button>
        </>,
      )}
      <Modal
        title="确认助手改动"
        open={confirmOpen && pendingId !== null}
        onCancel={() => {
          if (!applying && !discarding) setConfirmOpen(false);
        }}
        footer={null}
        width={520}
        destroyOnHidden
        maskClosable={false}
      >
        <AgentApplyConfirm
          lines={changeLines}
          applying={applying}
          discarding={discarding}
          onApply={() => void applyPending()}
          onDiscard={() => void discardPending()}
          onLater={() => setConfirmOpen(false)}
        />
      </Modal>
      <div className="agents-split">
        <Card className="agents-list">
          <div className="agents-list-scroll" ref={listRef}>
            {drafts.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有助手" />
            ) : (
              drafts.map((draft) => {
                const selected = draft.key === active?.key;
                const name = draft.def.name.trim() || '未命名助手';
                const summary = assistantSummary(buildBuckets(tools, draft.def.tools), draft.def.tools);
                return (
                  <button
                    key={draft.key}
                    type="button"
                    className={selected ? 'agents-item is-selected' : 'agents-item'}
                    aria-pressed={selected}
                    onClick={() => selectAgent(draft.key)}
                  >
                    <span className="agents-item-name">
                      {name}
                      {!draft.persisted ? (
                        <Tag color="blue" style={{ marginInlineStart: 8 }}>
                          新建
                        </Tag>
                      ) : null}
                    </span>
                    <span className="agents-item-meta">{summary}</span>
                  </button>
                );
              })
            )}
          </div>
        </Card>

        {active ? (
          <Card className="agents-detail" key={active.key}>
            <div className="agents-identity">
              <Input
                className="agents-id"
                aria-label="助手 id"
                value={active.def.id}
                placeholder="如 inspector"
                disabled={active.persisted}
                onChange={(e) => patchActive({ id: e.target.value.trim() })}
              />
              <Hint text="id 保存后不能改。对话和审计都用它认出是哪个助手。" />
              <Input
                className="agents-name"
                aria-label="展示名"
                value={active.def.name}
                placeholder="如 质检助手"
                onChange={(e) => patchActive({ name: e.target.value })}
              />
              <Input
                className="agents-desc"
                aria-label="职责说明"
                value={active.def.description}
                placeholder="一句话职责"
                onChange={(e) => patchActive({ description: e.target.value })}
              />
              <Hint text="这句话显示在对话页切换助手的菜单里。" />
              <Popover
                trigger="click"
                placement="bottomRight"
                content={
                  <div className="agents-persona">
                    <FieldLabel label="人设" hint="放在全局规则前面，规定这个助手的职责和口气。" />
                    <Input.TextArea
                      value={active.def.systemPrompt}
                      placeholder="如：你是质检助手，只负责核查临期批次并给出处置建议……"
                      rows={8}
                      onChange={(e) => patchActive({ systemPrompt: e.target.value })}
                    />
                  </div>
                }
              >
                <Button>人设</Button>
              </Popover>
              <Popover
                trigger="click"
                placement="bottomRight"
                content={
                  <div className="agents-more">
                    <div>
                      <FieldLabel label="模型覆盖" hint="留空则用 AI 模型页里正在使用的模型。" />
                      <Input
                        value={active.def.model ?? ''}
                        placeholder="留空则用当前模型"
                        onChange={(e) => patchActive({ model: e.target.value.trim() || undefined })}
                      />
                    </div>
                    <div>
                      <FieldLabel label="按角色分配" hint="还没有角色，这里先不能填。" />
                      <Input disabled placeholder="引入角色后开放" />
                    </div>
                  </div>
                }
              >
                <Button>更多</Button>
              </Popover>
              <Popconfirm
                title="从清单里去掉这个助手？"
                description="还没保存。去掉后要点保存，才会变成提议。"
                okText="删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                onConfirm={removeAgent}
              >
                <Button danger icon={<DeleteOutlined />} disabled={saving} aria-label="删除该助手">
                  删除
                </Button>
              </Popconfirm>
            </div>
            <div className="agents-detail-body">
              {area ? (
                <>
                  <Button type="link" onClick={() => setAreaId(null)} style={{ paddingInline: 0, alignSelf: 'flex-start' }}>
                    业务一览
                  </Button>
                  <AreaPanel
                    key={area.id}
                    bucket={area}
                    granted={active.def.tools}
                    onChange={(next) => patchActive({ tools: next })}
                  />
                </>
              ) : (
                <AreaGrid
                  buckets={buckets}
                  granted={active.def.tools}
                  onOpen={setAreaId}
                  onDropMissing={(ids) => patchActive({ tools: applyToolIds(active.def.tools, ids, false) })}
                />
              )}
            </div>
          </Card>
        ) : (
          <Card className="agents-detail">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="从左侧选一个助手，或点上方「新建助手」" />
          </Card>
        )}
      </div>
    </div>
  );
}
