import { Fragment, useState } from 'react';
import { Alert, Card, Switch } from 'antd';
import PageHeader from '../components/PageHeader';
import {
  FLOW_NODES,
  FLOW_TAGS,
  flowResult,
  laneTitle,
  type FlowLane,
  type FlowNodeDef,
  type FlowTagDef,
} from '../lib/module-present';
import ChangeConfirm from './ChangeConfirm';
import { shownEnabled, useModuleReview, type InstalledModule, type ModulePreview } from './use-module-review';

/**
 * 流程。左边选出库或入库，右边从上往下走。
 * 可选步骤是方块上的开关，关掉后箭头绕过它。
 * 拣货占用、短收短发、单据冲销只是方块上的开关，不另加方块。
 * 出库怎么扣在规则页，不放在这张图上。
 */

const LANES: readonly FlowLane[] = ['inbound', 'outbound'];

const LANE_HINT: Record<FlowLane, string> = {
  inbound: '收货 · 质检 · 上架',
  outbound: '拣货 · 复核 · 发货',
};

const LANE_LEAD: Record<FlowLane, string> = {
  inbound: '从上到下做到完成。关掉的步骤会变灰，这一单跳过它。',
  outbound: '从上到下做到发货。关掉的步骤会变灰，这一单跳过它。',
};

const PAGE_STYLE = `
.flow-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1;
  min-height: 0;
  min-width: 0;
  width: 100%;
}
.flow-split {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
  align-items: stretch;
  border: 1px solid #e8edf3;
  border-radius: 16px;
  overflow: hidden;
  background: #fff;
  box-shadow: 0 10px 30px rgba(16, 36, 69, 0.04);
}
.flow-list {
  width: 232px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-right: 1px solid #eef1f6;
  min-height: 0;
  overflow: auto;
  background: #fff;
  padding: 16px 12px;
  box-sizing: border-box;
}
.flow-list-kicker {
  margin: 0;
  padding: 2px 8px 6px;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
}
.flow-list-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  padding: 12px 14px;
  cursor: pointer;
  color: inherit;
  font: inherit;
}
.flow-list-item:hover { background: #f7f9fc; }
.flow-list-item[aria-current="true"] {
  background: #f0f7ff;
  border-color: #91caff;
}
.flow-list-name { font-size: 15px; font-weight: 600; }
.flow-list-hint { font-size: 12px; line-height: 1.4; color: rgba(0, 0, 0, 0.45); }
.flow-detail {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  background: #f5f7fb;
}
.lane-head {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 20px 28px 4px;
  background: linear-gradient(#f5f7fb 72%, rgba(245, 247, 251, 0));
}
.lane-title {
  margin: 0;
  font-size: 20px;
  font-weight: 650;
  letter-spacing: 0.01em;
}
.lane-lead {
  margin: 6px 0 0;
  max-width: 460px;
  color: rgba(0, 0, 0, 0.45);
  font-size: 13px;
  line-height: 1.55;
}
.chart {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  margin: 0 auto;
  padding: 8px 24px 48px 72px;
  box-sizing: border-box;
}
.chart::before {
  content: "";
  position: absolute;
  left: 30px;
  top: 30px;
  bottom: 56px;
  width: 2px;
  border-radius: 1px;
  background: #d6e4ff;
}
.node {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  width: 100%;
  box-sizing: border-box;
  padding: 14px 16px;
  border: 1px solid #e6ebf2;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 1px 2px rgba(16, 36, 69, 0.04), 0 8px 24px rgba(16, 36, 69, 0.04);
}
.node.is-off {
  border-style: dashed;
  border-color: #d5dbe3;
  background: rgba(255, 255, 255, 0.72);
  box-shadow: none;
}
.node-mark {
  position: absolute;
  left: -52px;
  top: 16px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #1677ff;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  box-shadow: 0 0 0 4px #f5f7fb;
}
.node.is-off .node-mark {
  background: #f5f7fb;
  color: transparent;
  box-shadow: 0 0 0 4px #f5f7fb, inset 0 0 0 2px #c5cdd8;
}
.node-label {
  flex: 1;
  font-size: 15px;
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
}
.node.is-off .node-label { color: rgba(0, 0, 0, 0.45); }
.node-skip {
  flex: none;
  padding: 0 8px;
  border-radius: 999px;
  background: #f0f2f5;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  line-height: 20px;
}
.node-switch {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.65);
}
.edge {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 0;
  box-sizing: border-box;
}
.edge-arrow {
  height: 18px;
  overflow: hidden;
  color: transparent;
  font-size: 0;
  line-height: 0;
}
.flow-page .change-confirm {
  flex: 1 0 100%;
  width: 100%;
  box-sizing: border-box;
}
@media (max-width: 800px) {
  .flow-split { flex-direction: column; }
  .flow-list {
    width: auto;
    flex-direction: row;
    border-right: none;
    border-bottom: 1px solid #eef1f6;
  }
  .flow-list-kicker { display: none; }
  .flow-list-item { flex: 1; }
}
`;

export default function FlowsPage() {
  const review = useModuleReview('流程');
  const { snapshotQuery, snapshot, installed } = review;
  const [lane, setLane] = useState<FlowLane>('inbound');

  const pick = (next: FlowLane) => {
    if (next === lane || review.confirming) return;
    review.dismiss();
    setLane(next);
  };

  return (
    <div className="flow-page app-fill">
      <style>{PAGE_STYLE}</style>
      <PageHeader title="流程" subtitle="左边选一条。右边从上往下看，长了只滚右边。确认后才生效。" />
      {snapshotQuery.isError ? (
        <Alert type="error" showIcon message="读不到流程配置" />
      ) : snapshotQuery.isLoading || !snapshot ? (
        <Card loading />
      ) : (
        <div className="flow-split">
          <nav className="flow-list" aria-label="流程列表">
            <p className="flow-list-kicker">选择流程</p>
            {LANES.map((item) => (
              <button
                key={item}
                type="button"
                className="flow-list-item"
                aria-current={item === lane ? 'true' : undefined}
                onClick={() => pick(item)}
              >
                <span className="flow-list-name">{laneTitle(item)}</span>
                <span className="flow-list-hint">{LANE_HINT[item]}</span>
              </button>
            ))}
          </nav>
          <div className="flow-detail">
            <Lane lane={lane} installed={installed} review={review} />
          </div>
        </div>
      )}
    </div>
  );
}

function Lane({
  lane,
  installed,
  review,
}: {
  lane: FlowLane;
  installed: InstalledModule[];
  review: ReturnType<typeof useModuleReview>;
}) {
  const nodes = FLOW_NODES.filter((node) => node.lane === lane).filter(
    (node) => !node.moduleId || installed.some((card) => card.id === node.moduleId && !card.system),
  );
  const active = (node: FlowNodeDef) => !node.moduleId || moduleOn(installed, node.moduleId, review.preview);
  const live = nodes.filter(active);

  return (
    <section className="lane" aria-label={laneTitle(lane)}>
      <header className="lane-head">
        <div className="lane-title">{laneTitle(lane)}</div>
        <p className="lane-lead">{LANE_LEAD[lane]}</p>
      </header>
      <div className="chart" data-testid={`${lane}-chart`}>
        {live.map((node, index) => {
          const prev = live[index - 1];
          const skipped = prev ? nodesBetween(nodes, prev, node).filter((item) => !active(item)) : [];
          return (
            <Fragment key={`${lane}-${node.id}`}>
              {prev ? (
                <Edge from={prev.label} to={node.label} skipped={skipped} installed={installed} review={review} lane={lane} />
              ) : null}
              <FlowBox node={node} installed={installed} review={review} lane={lane} off={false} step={index + 1} />
            </Fragment>
          );
        })}
      </div>
    </section>
  );
}

function Edge({
  from,
  to,
  skipped,
  installed,
  review,
  lane,
}: {
  from: string;
  to: string;
  skipped: FlowNodeDef[];
  installed: InstalledModule[];
  review: ReturnType<typeof useModuleReview>;
  lane: FlowLane;
}) {
  return (
    <div className="edge" data-from={from} data-to={to}>
      <span className="edge-arrow" aria-hidden="true">
        ↓
      </span>
      {skipped.map((node) => (
        <Fragment key={node.id}>
          <FlowBox node={node} installed={installed} review={review} lane={lane} off />
          <span className="edge-arrow" aria-hidden="true">
            ↓
          </span>
        </Fragment>
      ))}
    </div>
  );
}

function FlowBox({
  node,
  installed,
  review,
  lane,
  off,
  step,
}: {
  node: FlowNodeDef;
  installed: InstalledModule[];
  review: ReturnType<typeof useModuleReview>;
  lane: FlowLane;
  off: boolean;
  step?: number;
}) {
  const own = node.moduleId ? installed.find((card) => card.id === node.moduleId) : undefined;
  const tags = FLOW_TAGS.filter(
    (tag) => tag.lane === lane && tag.nodeId === node.id && installed.some((card) => card.id === tag.moduleId && !card.system),
  );
  const place = (moduleId: string) => `${lane}:${node.id}:${moduleId}`;
  return (
    <div className={off ? 'node is-off' : 'node'} data-node={node.label} data-active={off ? 'false' : 'true'}>
      <span className="node-mark" aria-hidden="true">
        {off ? '' : step}
      </span>
      <div className="node-label">{node.label}</div>
      {off ? <span className="node-skip">跳过</span> : null}
      {own && node.moduleId && node.toggle !== false ? (
        <NodeSwitch card={own} label={node.label} place={place(node.moduleId)} review={review} />
      ) : null}
      {tags.map((tag) => {
        const card = installed.find((item) => item.id === tag.moduleId);
        if (!card) return null;
        return (
          <TagSwitch
            key={`${tag.lane}-${tag.nodeId}-${tag.moduleId}`}
            tag={tag}
            nodeLabel={node.label}
            card={card}
            place={place(tag.moduleId)}
            review={review}
          />
        );
      })}
    </div>
  );
}

function NodeSwitch({
  card,
  label,
  place,
  review,
}: {
  card: InstalledModule;
  label: string;
  place: string;
  review: ReturnType<typeof useModuleReview>;
}) {
  const on = shownEnabled(card, review.preview);
  return (
    <>
      <div className="node-switch">
        <Switch
          aria-label={label}
          checked={on}
          disabled={review.busy}
          loading={review.proposingId === card.id && review.preview?.place === place}
          onChange={(enabled) => void review.start(card.id, enabled, `${enabled ? '打开' : '关掉'}${label}`, place)}
        />
      </div>
      {review.preview?.place === place ? <ConfirmHere review={review} moduleId={card.id} /> : null}
    </>
  );
}

function TagSwitch({
  tag,
  nodeLabel,
  card,
  place,
  review,
}: {
  tag: FlowTagDef;
  nodeLabel: string;
  card: InstalledModule;
  place: string;
  review: ReturnType<typeof useModuleReview>;
}) {
  const on = shownEnabled(card, review.preview);
  return (
    <>
      <div className="node-switch">
        <span>{tag.label}</span>
        <Switch
          aria-label={`${nodeLabel}：${tag.label}`}
          checked={on}
          disabled={review.busy}
          loading={review.proposingId === card.id && review.preview?.place === place}
          onChange={(enabled) => void review.start(card.id, enabled, `${enabled ? '打开' : '关掉'}${tag.label}`, place)}
        />
      </div>
      {review.preview?.place === place ? <ConfirmHere review={review} moduleId={card.id} /> : null}
    </>
  );
}

function ConfirmHere({ review, moduleId }: { review: ReturnType<typeof useModuleReview>; moduleId: string }) {
  const enabled = review.preview?.enabled ?? false;
  return (
    <ChangeConfirm
      text={flowResult(moduleId, enabled)}
      report={review.report}
      confirming={review.confirming}
      onDismiss={review.dismiss}
      onApply={() => void review.apply()}
      nameOf={review.nameOf}
    />
  );
}

function moduleOn(installed: InstalledModule[], moduleId: string, preview: ModulePreview | null): boolean {
  const card = installed.find((item) => item.id === moduleId);
  if (!card) return false;
  return shownEnabled(card, preview);
}

function nodesBetween(nodes: FlowNodeDef[], from: FlowNodeDef, to: FlowNodeDef): FlowNodeDef[] {
  const start = nodes.findIndex((node) => node.id === from.id);
  const end = nodes.findIndex((node) => node.id === to.id);
  if (start < 0 || end < 0 || end <= start) return [];
  return nodes.slice(start + 1, end);
}
