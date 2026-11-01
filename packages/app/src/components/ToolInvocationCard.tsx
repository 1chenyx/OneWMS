import { Button, Card, Descriptions, Tag, Typography } from 'antd';
import type { ChatInvocation } from '../api/client';
import type { InitialFilter, Page } from '../app-nav';
import AskCard from './AskCard';
import ToolResultView from './ToolResultView';

/**
 * 工具调用过程卡片：让「AI 经工具总线操作」对用户可见可审计（§9.3 透明度）。
 * 成/败/执行中分色 + 参数与结果摘要（折叠态保持简洁，展开看细节）。
 * 流式推进：tool-call 事件先落卡（执行中，灰色），tool-result 事件回填终态。
 * 成功结果经 ToolResultView 按 toolId 渲染（查询工具出表格，其余 JSON 兜底）。
 *
 * ui.ask 分流（M12 步骤3）：挂起态渲染 AskCard（问题 + 回答输入，onAnswer
 * 由 ChatPage 注入会话壳的 answerAsk）；终态渲染问答回显。
 * 后置动作按钮（M12 步骤4）：工具成功后「去对应管理页」（onNavigate 由
 * ChatPage 注入 useAppNav().navigate，如 profile.propose → 配置确认页）。
 */
export default function ToolInvocationCard({
  invocation,
  onAnswer,
  onNavigate,
}: {
  invocation: ChatInvocation;
  /** ui.ask 挂起时提交回答的通道（ChatPage 注入 useChatSession().answerAsk） */
  onAnswer?: (callId: string, answer: string | null) => void;
  /** 后置动作跳转通道（ChatPage 注入 useAppNav().navigate） */
  onNavigate?: (page: Page, filter?: InitialFilter) => void;
}) {
  const followUp = followUpAction(invocation);

  // ui.ask：等待回答 → 交互输入卡；已回填 → 问答回显
  if (invocation.toolId === 'ui.ask') {
    const question = typeof invocation.args.question === 'string' ? invocation.args.question : '';
    const declined =
      invocation.ok === true &&
      !!invocation.payload &&
      typeof invocation.payload === 'object' &&
      (invocation.payload as { declined?: unknown }).declined === true;
    const pending = invocation.ok === undefined;
    return (
      <Card
        size="small"
        style={{ maxWidth: 640 }}
        title={
          <>
            <Tag
              color={pending ? 'processing' : declined ? 'default' : invocation.ok ? 'green' : 'red'}
              bordered={false}
            >
              {pending ? '等待回答' : declined ? '未回答' : invocation.ok ? '已回答' : '被拒'}
            </Tag>
            <Typography.Text code>ui.ask</Typography.Text>
          </>
        }
      >
        {pending ? (
          onAnswer ? (
            <AskCard callId={invocation.callId} question={question} onAnswer={onAnswer} />
          ) : (
            <Typography.Paragraph style={{ marginBottom: 0 }}>{question}</Typography.Paragraph>
          )
        ) : (
          <>
            <Typography.Paragraph style={{ marginBottom: 8 }}>{question}</Typography.Paragraph>
            <ToolResultView toolId="ui.ask" payload={invocation.payload} />
          </>
        )}
      </Card>
    );
  }

  const errorText =
    invocation.ok === false && invocation.payload && typeof invocation.payload === 'object'
      ? String((invocation.payload as { error?: unknown }).error ?? '')
      : '';
  return (
    <Card
      size="small"
      style={{ maxWidth: 640 }}
      title={
        <>
          <Tag
            color={invocation.ok === undefined ? 'default' : invocation.ok ? 'green' : 'red'}
            bordered={false}
          >
            {invocation.ok === undefined ? '执行中' : invocation.ok ? '成功' : '被拒'}
          </Tag>
          <Typography.Text code>{invocation.toolId}</Typography.Text>
        </>
      }
    >
      <Descriptions column={1} size="small">
        <Descriptions.Item label="参数">
          <Typography.Text code style={{ fontSize: 12 }}>
            {JSON.stringify(invocation.args)}
          </Typography.Text>
        </Descriptions.Item>
        {!invocation.ok && errorText ? (
          <Descriptions.Item label="原因">
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              {errorText}
            </Typography.Text>
          </Descriptions.Item>
        ) : null}
      </Descriptions>
      {invocation.ok === true && invocation.payload !== undefined && invocation.payload !== null ? (
        <ToolResultView toolId={invocation.toolId} payload={invocation.payload} />
      ) : null}
      {followUp && onNavigate ? (
        <Button
          size="small"
          type="link"
          style={{ marginTop: 8, padding: 0 }}
          onClick={() => onNavigate(followUp.page, followUp.filter)}
        >
          {followUp.label} →
        </Button>
      ) : null}
    </Card>
  );
}

/** 后置动作：工具成功后的「去对应管理页」跳转（AI 操作与管理页的衔接） */
interface FollowUpAction {
  label: string;
  page: Page;
  filter?: InitialFilter;
}

/** payload 字段安全取字符串（缺省/非字符串返回 undefined，页面侧按无过滤处理） */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * 工具 → 后置动作映射（仅成功终态）：
 *  - profile.propose → 配置确认页（慢通道闭环：提议等人工拍板）；
 *  - SKU 写操作 → SKU 管理页；建单 → 单据页（带单号过滤）；
 *  - 库存调整/移库/单 SKU 查询 → 库存页（带 SKU 过滤）；
 *  - inventory.query 平铺/全量清单形态不出（结果已在卡内成表，无单一落点）。
 * payload 结构是 @one/wms / @one/core 工具返回的手写镜像（前端不依赖后端包类型）。
 */
function followUpAction(invocation: ChatInvocation): FollowUpAction | undefined {
  if (invocation.ok !== true) return undefined;
  const payload =
    invocation.payload && typeof invocation.payload === 'object'
      ? (invocation.payload as Record<string, unknown>)
      : undefined;
  switch (invocation.toolId) {
    case 'profile.propose':
      return { label: '去确认提议', page: 'proposals' };
    case 'wms.sku.create':
    case 'wms.sku.update':
      return { label: '去 SKU 管理查看', page: 'skus' };
    case 'wms.order.create':
      return { label: '去单据查看', page: 'orders', filter: { orderNo: str(payload?.orderNo) } };
    case 'wms.inventory.adjust':
    case 'wms.inventory.move':
      return { label: '去库存页查看', page: 'inventory', filter: { skuCode: str(payload?.skuCode) } };
    case 'wms.inventory.query':
      // 单 SKU 分组形态（byLocation 是标志字段）→ 带 SKU 过滤跳库存页
      if (payload && Array.isArray(payload.byLocation)) {
        return { label: '去库存页查看', page: 'inventory', filter: { skuCode: str(payload.skuCode) } };
      }
      return undefined;
    default:
      return undefined;
  }
}
