import { Fragment, useMemo } from 'react';
import { RightOutlined } from '@ant-design/icons';
import { Card, Empty, Space, Tag, Tooltip, Typography } from 'antd';
import type { ProfileSnapshot } from '@one/core';
import { useDashboardOrders, useProfileSnapshot, useUiPages } from '../api/hooks';
import type { OrderStateCount } from '../api/client';
import PageHeader from '../components/PageHeader';
import { useAppNav } from '../app-nav';
import type { Page } from '../app-nav';
import { navCategoryFor, navIconFor, navItemsOf, navLabelOf } from '../nav';
import type { NavItem } from '../nav';
import { face } from '../theme';
import { LANES, LANE_LABEL, WORKFLOW_OF_LANE, isTerminalState, stagePage } from '../lib/workbench';
import type { Lane, ModuleFlags } from '../lib/workbench';

/**
 * 作业台——把「功能清单」换成「待办流水线」。
 *
 * 导航的痛点不是功能多，而是入口以功能为单位：功能越多，用户越得先知道自己要找什么。
 * 这里反过来，以流程状态为单位排布：哪一步压着单，就点哪一步，落点是唯一确定的。
 * 功能数量继续增长，普通操作员看到的入口数量不变。
 *
 * 流水线形状完全由 Profile 的 workflows 配置生成（states 数组顺序即流程顺序），
 * 不在这里写死状态清单：模块贡献新状态，本页自动多一个节点。
 */

/** 一条车道的流水线：节点 + 终态汇总 */
interface LaneBoard {
  lane: Lane;
  nodes: StageNode[];
  done: number;
  canceled: number;
  waiting: number;
}

interface StageNode {
  state: string;
  label: string;
  count: number;
  /** 推进这一步的页面。undefined = 没有专属页面（陌生状态或链路被关空），只读数不跳转 */
  page?: Page;
  /** 节点被降级的原因（贡献它的模块已关闭 / 配置里没有这个状态） */
  note?: string;
}

export default function WorkbenchPage() {
  const { navigate } = useAppNav();
  const snapshot = useProfileSnapshot();
  const orders = useDashboardOrders();
  const uiPages = useUiPages();

  const workflows = snapshot.data?.workflows ?? {};
  const modules = snapshot.data?.modules ?? {};
  const rows = orders.data ?? [];

  const boards = useMemo(
    () => LANES.map((lane) => buildBoard(lane, workflows, modules, rows)),
    [workflows, modules, rows],
  );
  // 流水线上有落点的页面不再重复出现在「其他作业」里
  const staged = useMemo(
    () => new Set(boards.flatMap((board) => board.nodes.map((node) => node.page).filter(Boolean))) as Set<Page>,
    [boards],
  );
  const others = useMemo(
    () => otherOpsItems(modules, uiPages.data?.pages, staged),
    [modules, uiPages.data?.pages, staged],
  );
  const waiting = boards.reduce((total, board) => total + board.waiting, 0);
  const loading = snapshot.isLoading || orders.isLoading;

  return (
    <>
      <PageHeader
        title="作业台"
        subtitle="按流程配置生成的待办流水线：哪一步压着单，就去哪一步"
        extra={
          <Tag color={waiting > 0 ? 'warning' : 'default'}>待处理单据 {waiting}</Tag>
        }
      />
      {boards.every((board) => board.nodes.length === 0) ? (
        <Card>
          <Empty description="当前 Profile 没有配置流程状态，请先在「流程配置」里定义入库/出库流程" />
        </Card>
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {boards.map((board) => (
            <Card
              key={board.lane}
              loading={loading}
              size="small"
              title={`${LANE_LABEL[board.lane]}流水线`}
              extra={
                <Space size={12}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    已完成 {board.done}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    已取消 {board.canceled}
                  </Typography.Text>
                </Space>
              }
            >
              {board.nodes.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这条流程还没有配置状态" />
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 8 }}>
                  {board.nodes.map((node, index) => (
                    <Fragment key={node.state}>
                      {index > 0 && (
                        <RightOutlined
                          aria-hidden
                          style={{ alignSelf: 'center', fontSize: 12, color: face.text3 }}
                        />
                      )}
                      <StageTile node={node} onPick={navigate} />
                    </Fragment>
                  ))}
                </div>
              )}
            </Card>
          ))}

          <Card size="small" title="其他作业" loading={loading}>
            {others.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有与流程无关的作业" />
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))', gap: 8 }}>
                {others.map((item) => (
                  <SideTile key={item.page} item={item} onPick={navigate} />
                ))}
              </div>
            )}
          </Card>
        </Space>
      )}
    </>
  );
}

/**
 * 由配置拼一条车道。
 *
 * 计数里出现、配置里却没有的状态（旧版本遗留、或配置被改窄）不会被丢掉：
 * 追加到末尾并标注「配置外」——账本上的单不能因为配置改了就在界面上凭空消失。
 */
function buildBoard(
  lane: Lane,
  workflows: ProfileSnapshot['workflows'],
  modules: ModuleFlags,
  rows: readonly OrderStateCount[],
): LaneBoard {
  const direction = lane === 'in' ? 'in' : 'out';
  const stated = workflows[WORKFLOW_OF_LANE[lane]]?.states ?? [];
  const countOf = new Map<string, number>();
  let done = 0;
  let canceled = 0;
  for (const row of rows) {
    if (row.direction !== direction) continue;
    countOf.set(row.state, (countOf.get(row.state) ?? 0) + row.count);
    if (row.state === 'done') done += row.count;
    if (row.state === 'canceled') canceled += row.count;
  }

  const nodes: StageNode[] = [];
  const seen = new Set<string>();
  for (const state of stated) {
    if (isTerminalState(state.id)) continue;
    seen.add(state.id);
    const provider = state.providedBy;
    nodes.push({
      state: state.id,
      label: state.label || state.id,
      count: countOf.get(state.id) ?? 0,
      page: stagePage(lane, state.id, modules),
      note: provider && modules[provider]?.enabled === false ? `贡献模块 ${provider} 已关闭` : undefined,
    });
  }
  for (const [state, count] of countOf) {
    if (seen.has(state) || isTerminalState(state)) continue;
    nodes.push({
      state,
      label: state,
      count,
      page: stagePage(lane, state, modules),
      note: '流程配置里没有这个状态（旧数据或配置被改窄）',
    });
  }

  const waiting = nodes.reduce((total, node) => total + node.count, 0);
  return { lane, nodes, done, canceled, waiting };
}

/**
 * 与流程无关的作业入口：内置项里没被流水线用上的 + 声明式模块页里归到「作业」的。
 * 挂 moduleId 的内置项按模块开关过滤（跟左侧大类浮窗同一套规则）；
 * 动态页面已由服务端按「已安装且启用」过滤过，不再二次判断。
 */
function otherOpsItems(
  modules: ModuleFlags,
  pages: readonly { id: string; label: string; icon?: string; category?: string }[] | undefined,
  staged: ReadonlySet<Page>,
): NavItem[] {
  const builtin = navItemsOf('ops').filter(
    (item) =>
      item.page !== 'workbench' &&
      !staged.has(item.page) &&
      (item.moduleId == null || modules[item.moduleId]?.enabled === true),
  );
  const dynamic: NavItem[] = (pages ?? [])
    .filter((item) => navCategoryFor(item.category) === 'ops' && !staged.has(item.id))
    .map((item) => ({ page: item.id, label: item.label, icon: navIconFor(item.icon) }));
  return [...builtin, ...dynamic];
}

function StageTile({ node, onPick }: { node: StageNode; onPick: (page: Page) => void }) {
  const idle = node.count === 0;
  const body = (
    <button
      type="button"
      disabled={node.page == null}
      onClick={() => node.page && onPick(node.page)}
      aria-label={`${node.label} ${node.count}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 2,
        minWidth: 108,
        padding: '10px 12px',
        border: `1px solid ${idle ? face.line : face.amber}`,
        borderRadius: 8,
        background: idle ? face.card : face.raised,
        color: face.ink,
        opacity: idle || node.note ? 0.55 : 1,
        cursor: node.page == null ? 'default' : 'pointer',
        font: 'inherit',
        textAlign: 'left',
      }}
    >
      <span style={{ fontSize: 12, color: face.text2 }}>{node.label}</span>
      <span style={{ fontSize: 22, fontWeight: 500, lineHeight: '28px' }}>{node.count}</span>
      <span style={{ fontSize: 12, color: face.text3 }}>
        {node.page ? `去${navLabelOf(node.page)}` : '无专属页面'}
      </span>
    </button>
  );
  return node.note ? <Tooltip title={node.note}>{body}</Tooltip> : body;
}

function SideTile({ item, onPick }: { item: NavItem; onPick: (page: Page) => void }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={() => onPick(item.page)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        minHeight: 64,
        padding: '10px 8px',
        border: `1px solid ${face.line}`,
        borderRadius: 8,
        background: face.card,
        color: face.ink,
        cursor: 'pointer',
        font: 'inherit',
      }}
    >
      <Icon style={{ fontSize: 16, color: face.text2 }} />
      <span style={{ fontSize: 12, lineHeight: '16px', whiteSpace: 'nowrap' }}>{item.label}</span>
    </button>
  );
}
