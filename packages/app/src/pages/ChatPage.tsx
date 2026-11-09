import { forwardRef, useEffect, useRef, useState } from 'react';
import type { ButtonProps } from 'antd';
import { DownOutlined, PaperClipOutlined, SendOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Dropdown, Input, Modal, Space, Spin, Tag, Typography } from 'antd';
import { api } from '../api/client';
import type { AgentDef, AiProfilePublic, ChatAttachmentPayload, ChatInvocation } from '../api/client';
import { useAiConfig, useProposals } from '../api/hooks';
import { useChatSession } from '../chat/ChatProvider';
import type { ChatTurn } from '../chat/ChatProvider';
import { parseChatFile, MAX_CHAT_FILES } from '../chat/parse-attachment';
import { useAppNav } from '../app-nav';
import type { InitialFilter, Page } from '../app-nav';
import { findVendor, modelsForVendor } from '../lib/ai-vendors';
import ProposalDetail from '../components/ProposalDetail';
import { proposalsForChat } from './agent-proposal';
import ToolInvocationCard from '../components/ToolInvocationCard';
import ToolRun from '../components/ToolRun';
import PageHeader from '../components/PageHeader';

/**
 * AI 对话面板（M12：SSE 流式 + 会话化；M16：多助手切换）：
 *  - 状态在 ChatProvider（App 级 context）——切页不丢对话；
 *  - 输入框底部两个下拉：切换助手（选项来自 GET /api/agents）、
 *    切换厂商和模型（一个按钮：厂商作子菜单分组，点是这个厂商的模型，
 *    预设加上已经保存过的名字）。地址和密钥跟这个厂商已保存的那一条走。
 *    切换助手 = 换新会话 + 清空历史（流式中锁定）；切换厂商或模型不换会话；
 *  - 配置确认：对话里的 profile.propose 和 AI 记忆设置一到就弹窗，
 *    写明将改成什么样、有什么影响；关掉后可从输入框上方再打开。
 *    助手定义的改动在助手管理页自己确认，不进这个窗口；
 *  - 流式渲染：一组工具调用先收成一句人话，展开才看明细；助手文本逐 delta 增长；
 *  - 成功的操作展开后仍可去对应管理页；
 *  - 输入区可以带上 Excel、CSV 或文本，用户说怎么处理，助手就怎么处理。
 */

/** 已配置过的厂商，按第一次出现的顺序。名字用预设，没有预设就用保存时的称呼。 */
function configuredVendors(profiles: AiProfilePublic[]): { vendorId: string; name: string }[] {
  const seen = new Set<string>();
  const out: { vendorId: string; name: string }[] = [];
  for (const profile of profiles) {
    if (seen.has(profile.vendorId)) continue;
    seen.add(profile.vendorId);
    out.push({ vendorId: profile.vendorId, name: findVendor(profile.vendorId)?.name ?? profile.label });
  }
  return out;
}

/** 这个厂商用来带地址和密钥的那一条：模型名对上优先，其次有密钥的，否则第一条。 */
function credentialFor(profiles: AiProfilePublic[], vendorId: string, modelId: string): AiProfilePublic | undefined {
  const saved = profiles.filter((item) => item.vendorId === vendorId);
  return saved.find((item) => item.model === modelId) ?? saved.find((item) => item.apiKeySet) ?? saved[0];
}

/** 输入框底栏的可点控件：浅底圆角，悬停再深一点 */
const ComposerChip = forwardRef<HTMLButtonElement, ButtonProps>(function ComposerChip(
  { children, style, disabled, onMouseEnter, onMouseLeave, ...rest },
  ref,
) {
  const [hover, setHover] = useState(false);
  return (
    <Button
      {...rest}
      ref={ref}
      type="text"
      size="small"
      disabled={disabled}
      onMouseEnter={(event) => {
        setHover(true);
        onMouseEnter?.(event);
      }}
      onMouseLeave={(event) => {
        setHover(false);
        onMouseLeave?.(event);
      }}
      style={{
        background: disabled ? '#f5f5f5' : hover ? '#e4e4e4' : '#f0f0f0',
        borderRadius: 999,
        paddingInline: 12,
        ...style,
      }}
    >
      {children}
    </Button>
  );
});

export default function ChatPage() {
  const { message } = AntApp.useApp();
  const chat = useChatSession();
  const { navigate } = useAppNav();
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<ChatAttachmentPayload[]>([]);
  const [readingFile, setReadingFile] = useState(false);
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 待确认提议：5s 轮询 + 对话里刚提议就刷新。新提议立刻弹窗，不堆在页头。
  const proposalsQuery = useProposals();
  const proposals = proposalsQuery.data;
  const [openProposalId, setOpenProposalId] = useState<string | null>(null);
  const promptedRef = useRef(new Set<string>());

  // AI 未配置引导：检测到未配置即在顶部展示引导卡（AiConfigPage 保存后缓存失效、返回即消失）
  const aiConfigQuery = useAiConfig();
  const aiUnconfigured = aiConfigQuery.data !== undefined && !aiConfigQuery.data.configured;

  // 对话里 profile.propose 刚成功 → 立即刷新提议（不等 5s 轮询）。
  // refetch 经 ref 中转：依赖只留 proposeCount，避免查询对象身份变化触发回流。
  const proposeCount = chat.turns.reduce(
    (n, t) => n + t.invocations.filter((i) => i.toolId === 'profile.propose' && i.ok === true).length,
    0,
  );
  const refetchProposals = useRef(proposalsQuery.refetch);
  refetchProposals.current = proposalsQuery.refetch;
  useEffect(() => {
    if (proposeCount > 0) void refetchProposals.current?.();
  }, [proposeCount]);

  // 还没弹过的配置提议马上打开。助手定义不进这个窗口。关掉或拍板后不再自动弹出同一条。
  const configProposals = proposalsForChat(proposals);
  useEffect(() => {
    const pending = proposalsForChat(proposals);
    if (openProposalId && pending.some((item) => item.proposalId === openProposalId)) return;
    const fresh = pending.find((item) => !promptedRef.current.has(item.proposalId));
    if (fresh) {
      promptedRef.current.add(fresh.proposalId);
      setOpenProposalId(fresh.proposalId);
      return;
    }
    if (openProposalId) setOpenProposalId(null);
  }, [proposals, openProposalId]);

  const holdProposal = () => setOpenProposalId(null);

  // 助手清单（M16）：挂载拉取；失败静默——仅显示当前 agentId，切换器空态可接受
  useEffect(() => {
    let alive = true;
    api
      .agents()
      .then((catalog) => alive && setAgents(catalog.agents))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const profiles = aiConfigQuery.data?.profiles ?? [];
  const activeProfile = profiles.find((item) => item.active) ?? profiles[0];
  const selectedProfile = profiles.find((item) => item.id === chat.profileId) ?? activeProfile;
  const vendors = configuredVendors(profiles);
  const shownVendorId = selectedProfile?.vendorId;

  // 选中的那条被删掉了，或页面配置清空了：回到当前生效的模型，别再把过期 id 发出去。
  // 依赖用查询结果本身，避免 profiles 缺省时每次渲染都是新数组。
  const savedProfiles = aiConfigQuery.data?.profiles;
  useEffect(() => {
    if (!chat.profileId) return;
    const list = savedProfiles ?? [];
    if (list.some((item) => item.id === chat.profileId)) return;
    chat.setProfileId(activeProfile?.id);
  }, [activeProfile?.id, chat.profileId, chat.setProfileId, savedProfiles]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' });
  }, [chat.turns]);

  const send = () => {
    const text = input.trim();
    if ((!text && files.length === 0) || chat.isStreaming || readingFile) return;
    setInput('');
    const attached = files;
    setFiles([]);
    void chat.send(text, attached);
  };

  const onPickFiles = (list: FileList | null) => {
    const picked = list ? [...list] : [];
    if (fileRef.current) fileRef.current.value = '';
    if (picked.length === 0) return;
    const room = MAX_CHAT_FILES - files.length;
    if (room <= 0) {
      message.warning(`一次最多带 ${MAX_CHAT_FILES} 个文件`);
      return;
    }
    const batch = picked.slice(0, room);
    if (picked.length > room) message.warning(`一次最多带 ${MAX_CHAT_FILES} 个文件，多出来的没有加入`);
    setReadingFile(true);
    void (async () => {
      const next: ChatAttachmentPayload[] = [];
      for (const file of batch) {
        try {
          next.push(await parseChatFile(file));
        } catch (err) {
          message.error(err instanceof Error ? err.message : `${file.name} 读不了`);
        }
      }
      if (next.length > 0) setFiles((prev) => [...prev, ...next].slice(0, MAX_CHAT_FILES));
      setReadingFile(false);
    })();
  };

  const agentName = agents.find((agent) => agent.id === chat.agentId)?.name;
  const configModel = aiConfigQuery.data?.config?.model;
  const shownVendorName = shownVendorId
    ? (findVendor(shownVendorId)?.name ?? selectedProfile?.label)
    : undefined;
  const shownModel = chat.model ?? selectedProfile?.model ?? (profiles.length === 0 ? configModel : undefined);
  const acceptDrop = !chat.isStreaming && !readingFile;

  const chooseModel = (vendorId: string, modelId: string) => {
    const credential = credentialFor(profiles, vendorId, modelId);
    if (!credential) return;
    chat.setProfileId(credential.id, modelId === credential.model ? undefined : modelId);
  };

  return (
    <div
      className="app-fill"
      style={{
        width: '100%',
        maxWidth: 860,
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        flex: 1,
        height: '100%',
        maxHeight: '100%',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <PageHeader title="AI 对话" subtitle="自然语言出入库 / 改配置" />
      {/* AI 未配置引导卡：配置保存成功后自动消失 */}
      {aiUnconfigured ? (
        <Alert
          type="info"
          showIcon
          message="尚未配置 AI 服务"
          description="完成模型配置后即可用自然语言管理仓库（支持 OpenAI 兼容云 API 或本地 Ollama）。"
          action={
            <Button size="small" type="primary" onClick={() => navigate('ai-config')}>
              去配置
            </Button>
          }
        />
      ) : null}
      <Modal
        title="请确认配置变更"
        open={openProposalId !== null}
        onCancel={holdProposal}
        footer={null}
        width={640}
        destroyOnHidden
        maskClosable={false}
      >
        {openProposalId ? (
          <ProposalDetail proposalId={openProposalId} onDone={holdProposal} onLater={holdProposal} />
        ) : null}
      </Modal>
      <Card
        style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}
        styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' } }}
      >
        <div ref={listRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 8 }}>
          {chat.turns.length === 0 ? (
            <Typography.Paragraph type="secondary" style={{ padding: 24 }}>
              试试说：「建一个 SKU：A-1001 轴承」「A-1001 入库 50 个」。
              也可以导入 Excel、CSV 或文本，再说怎么处理，比如「按这张表入库」或「这些是新商品，帮我建档」。
              改配置会立刻弹出确认，写明要改成什么样、有什么影响。
            </Typography.Paragraph>
          ) : null}
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {chat.turns.map((turn, idx) => (
              <div key={idx}>
                <UserBubble turn={turn} />
                <TurnActivity turn={turn} onAnswer={chat.answerAsk} onNavigate={navigate} />
                {turn.assistantText ? (
                  <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                    {turn.assistantText}
                  </Typography.Paragraph>
                ) : null}
                {turn.failed ? (
                  <Typography.Paragraph type="danger" style={{ marginBottom: 0 }}>
                    {turn.failed}
                    {turn.failedCode === 'AI_NOT_CONFIGURED' ? (
                      <Typography.Link style={{ marginLeft: 8 }} onClick={() => navigate('ai-config')}>
                        去配置
                      </Typography.Link>
                    ) : null}
                  </Typography.Paragraph>
                ) : null}
              </div>
            ))}
            {chat.isStreaming ? <Spin tip="思考中…" /> : null}
          </Space>
        </div>
        {configProposals.length > 0 && openProposalId === null ? (
          <div style={{ marginTop: 12 }}>
            <Button onClick={() => setOpenProposalId(configProposals[0]!.proposalId)}>
              有 {configProposals.length} 项配置等你确认
            </Button>
          </div>
        ) : null}
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <div
            aria-label="对话输入"
            onDragEnter={(e) => {
              e.preventDefault();
              if (acceptDrop) setDragOver(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (e.dataTransfer) e.dataTransfer.dropEffect = acceptDrop ? 'copy' : 'none';
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setDragOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (acceptDrop) onPickFiles(e.dataTransfer.files);
            }}
            style={{
              flex: 1,
              minWidth: 0,
              border: `1px solid ${dragOver ? '#1677ff' : '#d9d9d9'}`,
              borderRadius: 8,
              background: chat.isStreaming ? '#f5f5f5' : dragOver ? '#e6f4ff' : '#fff',
              padding: '8px 8px 4px 12px',
            }}
          >
            {files.length > 0 ? (
              <Space size={4} wrap style={{ marginBottom: 4 }}>
                {files.map((file) => (
                  <Tag
                    key={file.id}
                    closable={!chat.isStreaming}
                    onClose={() => setFiles((prev) => prev.filter((item) => item.id !== file.id))}
                  >
                    {file.name}
                    {file.kind === 'table' ? ` · ${file.rows.length} 行` : ''}
                  </Tag>
                ))}
              </Space>
            ) : null}
            <Input.TextArea
              value={input}
              variant="borderless"
              rows={3}
              onChange={(e) => setInput(e.target.value)}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="输入指令，Enter 发送（Shift+Enter 换行）。可以把 Excel、CSV 或文本拖进这里，再说怎么处理"
              disabled={chat.isStreaming}
              style={{ padding: '4px 0', resize: 'none' }}
            />
            <input
              ref={fileRef}
              type="file"
              aria-label="导入文件"
              accept=".xlsx,.xlsm,.csv,.txt,.text,.md,text/csv,text/plain"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => onPickFiles(e.target.files)}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Dropdown
                trigger={['click']}
                disabled={chat.isStreaming || agents.length === 0}
                menu={{
                  selectable: true,
                  selectedKeys: [chat.agentId],
                  items: agents.map((agent) => ({
                    key: agent.id,
                    label: agent.name,
                    title: agent.description || undefined,
                  })),
                  onClick: ({ key }) => chat.setAgentId(String(key)),
                }}
              >
                <ComposerChip>
                  {agentName ? `助手：${agentName}` : '助手'} <DownOutlined aria-hidden />
                </ComposerChip>
              </Dropdown>
              <Dropdown
                trigger={['click']}
                disabled={chat.isStreaming || profiles.length === 0 || vendors.length === 0}
                menu={{
                  selectable: true,
                  triggerSubMenuAction: 'click',
                  selectedKeys: shownModel ? [shownModel] : [],
                  style: { maxHeight: 320, overflow: 'auto' },
                  items: vendors.map((item) => {
                    const saved = profiles.filter((profile) => profile.vendorId === item.vendorId);
                    return {
                      key: item.vendorId,
                      label: item.name,
                      children: modelsForVendor(item.vendorId, saved.map((profile) => profile.model)).map(
                        (modelId) => ({ key: modelId, label: modelId }),
                      ),
                    };
                  }),
                  onClick: ({ key, keyPath }) => {
                    const vendorId = keyPath[keyPath.length - 1];
                    if (vendorId) chooseModel(vendorId, String(key));
                  },
                }}
              >
                <ComposerChip style={{ maxWidth: 320 }}>
                  {shownVendorName ? `${shownVendorName} · ${shownModel ?? '模型'}` : (shownModel ?? '模型')}{' '}
                  <DownOutlined aria-hidden />
                </ComposerChip>
              </Dropdown>
              <div style={{ flex: 1 }} />
              <ComposerChip icon={<PaperClipOutlined />} disabled={!acceptDrop} onClick={() => fileRef.current?.click()}>
                导入文件
              </ComposerChip>
            </div>
          </div>
          <Button type="primary" icon={<SendOutlined />} onClick={send} loading={chat.isStreaming || readingFile}>
            发送
          </Button>
        </div>
      </Card>
    </div>
  );
}

function UserBubble({ turn }: { turn: ChatTurn }) {
  if (!turn.userText && !turn.attachments?.length) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
      <div style={{ background: '#e6f4ff', padding: '6px 12px', borderRadius: 8, maxWidth: '80%' }}>
        {turn.attachments?.map((file) => (
          <div key={file.id}>
            {file.name}
            {file.kind === 'table' && file.rows !== undefined ? ` · ${file.rows} 行` : ''}
          </div>
        ))}
        {turn.userText ? <div style={{ whiteSpace: 'pre-wrap' }}>{turn.userText}</div> : null}
      </div>
    </div>
  );
}

type Segment =
  | { kind: 'tools'; items: ChatInvocation[] }
  | { kind: 'ask'; item: ChatInvocation };

function segmentsOf(invocations: ChatInvocation[]): Segment[] {
  const out: Segment[] = [];
  let buf: ChatInvocation[] = [];
  const flush = () => {
    if (buf.length === 0) return;
    out.push({ kind: 'tools', items: buf });
    buf = [];
  };
  for (const inv of invocations) {
    if (inv.toolId === 'ui.ask') {
      flush();
      out.push({ kind: 'ask', item: inv });
    } else {
      buf.push(inv);
    }
  }
  flush();
  return out;
}

function TurnActivity({
  turn,
  onAnswer,
  onNavigate,
}: {
  turn: ChatTurn;
  onAnswer: (callId: string, answer: string | null) => void;
  onNavigate: (page: Page, filter?: InitialFilter) => void;
}) {
  const segments = segmentsOf(turn.invocations);
  if (segments.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
      {segments.map((segment) =>
        segment.kind === 'ask' ? (
          <ToolInvocationCard
            key={segment.item.callId}
            invocation={segment.item}
            onAnswer={onAnswer}
            onNavigate={onNavigate}
          />
        ) : (
          <ToolRun
            key={segment.items[0]?.callId}
            invocations={segment.items}
            onNavigate={onNavigate}
          />
        ),
      )}
    </div>
  );
}
