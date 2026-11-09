import { Button, Card, Tag, Typography } from 'antd';
import type { ChatInvocation } from '../api/client';
import type { InitialFilter, Page } from '../app-nav';
import { speakInvocation } from '../chat/tool-speak';
import AskCard from './AskCard';
import ToolResultView from './ToolResultView';

/**
 * 一次工具调用的说明。对话页把它放进可折叠的一组里；这里只说人话。
 * 成/败/执行中仍可区分。查询结果在展开后出表格，不展示参数和返回值的 JSON。
 *
 * ui.ask：挂起时是回答卡；终态回显问答。
 * 成功后可以跳到对应管理页。配置提议的确认在对话页顶部，不从这里跳走。
 */
export default function ToolInvocationCard({
  invocation,
  onAnswer,
  onNavigate,
  hideTitle = false,
}: {
  invocation: ChatInvocation;
  /** ui.ask 挂起时提交回答的通道（ChatPage 注入 useChatSession().answerAsk） */
  onAnswer?: (callId: string, answer: string | null) => void;
  /** 后置动作跳转通道（ChatPage 注入 useAppNav().navigate） */
  onNavigate?: (page: Page, filter?: InitialFilter) => void;
  /** 外层折叠条已经展示过这句话时，展开区不再重复 */
  hideTitle?: boolean;
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
            <Typography.Text>需要你补充</Typography.Text>
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

  const spoken = speakInvocation(invocation);
  const tabular = invocation.ok === true && isTabular(invocation);
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <Tag
          color={invocation.ok === undefined ? 'default' : invocation.ok ? 'green' : 'red'}
          bordered={false}
        >
          {invocation.ok === undefined ? '执行中' : invocation.ok ? '成功' : '被拒'}
        </Tag>
        {hideTitle ? null : <Typography.Text>{spoken.title}</Typography.Text>}
      </div>
      {!tabular && spoken.details.length > 0 ? (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {spoken.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {tabular ? <ToolResultView toolId={invocation.toolId} payload={invocation.payload} /> : null}
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
    </div>
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 查询结果用表格展示；写操作的小对象只用上面的一句话 */
function isTabular(invocation: ChatInvocation): boolean {
  if (
    invocation.toolId === 'wms.inventory.query' ||
    invocation.toolId === 'wms.inventory.expiring' ||
    invocation.toolId === 'wms.location.list'
  ) {
    return true;
  }
  const payload = invocation.payload;
  if (Array.isArray(payload)) return payload.length > 0 && isRecord(payload[0]);
  if (isRecord(payload) && Array.isArray(payload.rows)) {
    return payload.rows.length > 0 && isRecord(payload.rows[0]);
  }
  return false;
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
 *  - SKU 写操作 → SKU 管理页；建单 → 单据页（带单号过滤）；
 *  - 库存调整/移库/单 SKU 查询 → 库存页（带 SKU 过滤）；
 *  - 临期查询（M15）→ 效期看板：结果全部同一 SKU 时带过滤，多 SKU 不带；
 *  - inventory.query 平铺/全量清单形态不出（结果已在卡内成表，无单一落点）；
 *  - profile.propose 不出（确认在对话页弹窗里，不跳页）。
 * payload 结构是 @one/wms / @one/core 工具返回的手写镜像（前端不依赖后端包类型）。
 */
function followUpAction(invocation: ChatInvocation): FollowUpAction | undefined {
  if (invocation.ok !== true) return undefined;
  const payload =
    invocation.payload && typeof invocation.payload === 'object'
      ? (invocation.payload as Record<string, unknown>)
      : undefined;
  switch (invocation.toolId) {
    case 'wms.sku.create':
    case 'wms.sku.update':
      return { label: '去 SKU 管理查看', page: 'skus' };
    case 'wms.order.create': {
      const outbound = invocation.args.direction === 'out';
      return {
        label: outbound ? '去出库单查看' : '去入库单查看',
        page: outbound ? 'outbound' : 'inbound',
        filter: { orderNo: str(payload?.orderNo) },
      };
    }
    case 'wms.inventory.adjust':
    case 'wms.inventory.move':
      return { label: '去库存页查看', page: 'inventory', filter: { skuCode: str(payload?.skuCode) } };
    case 'wms.inventory.query':
      // 单 SKU 分组形态（byLocation 是标志字段）→ 带 SKU 过滤跳库存页
      if (payload && Array.isArray(payload.byLocation)) {
        return { label: '去库存页查看', page: 'inventory', filter: { skuCode: str(payload.skuCode) } };
      }
      return undefined;
    case 'wms.inventory.expiring': {
      // 结果行集合：全部同一 SKU（如「A-1 有什么临期」）→ 带 SKU 过滤预填；
      // 多 SKU / 空结果不带（看板全量即落点）
      const items = Array.isArray(payload) ? payload : [];
      const codes = new Set(
        items
          .map((r) => str((r as { skuCode?: unknown })?.skuCode))
          .filter((c): c is string => c !== undefined),
      );
      const filter = codes.size === 1 ? { skuCode: [...codes][0] } : undefined;
      return { label: '去效期看板', page: 'expiry', filter };
    }
    default:
      return undefined;
  }
}
