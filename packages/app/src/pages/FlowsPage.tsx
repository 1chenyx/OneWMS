import { Fragment } from 'react';
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
 * 流程。两张流程图。
 * 可选步骤是方块上的开关，关掉后箭头绕过它。
 * 拣货占用、短收短发、单据冲销只是方块上的开关，不另加方块。
 * 出库怎么扣在规则页，不放在这张图上。
 */

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
.flow-body {
  min-width: 0;
  width: 100%;
}
.lane-title {
  margin: 4px 0 10px;
  font-weight: 600;
}
.lane + .lane {
  margin-top: 28px;
}
.chart-scroll {
  overflow-x: auto;
  max-width: 100%;
  padding-bottom: 6px;
}
.chart {
  display: flex;
  align-items: flex-start;
  flex-wrap: nowrap;
  width: max-content;
  min-width: 100%;
}
.node {
  flex: 0 0 auto;
  padding: 8px 10px;
  border: 1px solid #1677ff;
  border-radius: 10px;
  background: #f0f7ff;
}
.node.is-off {
  border-style: dashed;
  border-color: #d9d9d9;
  background: #fafafa;
}
.node-label {
  font-weight: 600;
  text-align: center;
  white-space: nowrap;
}
.node.is-off .node-label {
  color: rgba(0, 0, 0, 0.45);
}
.node-switch {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 12px;
}
.edge {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: center;
  min-width: 28px;
  padding: 10px 4px 0;
}
.flow-page .change-confirm {
  width: 240px;
  box-sizing: border-box;
}
.edge-arrow {
  color: #1677ff;
  font-size: 18px;
  line-height: 1;
}
.edge .node {
  margin-top: 8px;
}
`;

export default function FlowsPage() {
  const review = useModuleReview('流程');
  const { snapshotQuery, snapshot, installed } = review;

  return (
    <div className="flow-page">
      <style>{PAGE_STYLE}</style>
      <PageHeader title="流程" subtitle="拨方块上的开关，箭头就改道。确认后才生效。" />
      {snapshotQuery.isError ? (
        <Alert type="error" showIcon message="读不到流程配置" />
      ) : snapshotQuery.isLoading || !snapshot ? (
        <Card loading />
      ) : (
        <div className="flow-body">
          <Lane lane="inbound" installed={installed} review={review} />
          <Lane lane="outbound" installed={installed} review={review} />
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
      <div className="lane-title">{laneTitle(lane)}</div>
      <div className="chart-scroll">
        <div className="chart" data-testid={`${lane}-chart`}>
        {live.map((node, index) => {
          const prev = live[index - 1];
          const skipped = prev ? nodesBetween(nodes, prev, node).filter((item) => !active(item)) : [];
          return (
            <Fragment key={`${lane}-${node.id}`}>
              {prev ? (
                <Edge from={prev.label} to={node.label} skipped={skipped} installed={installed} review={review} lane={lane} />
              ) : null}
              <FlowBox node={node} installed={installed} review={review} lane={lane} off={false} />
            </Fragment>
          );
        })}
        </div>
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
        →
      </span>
      {skipped.map((node) => (
        <FlowBox key={node.id} node={node} installed={installed} review={review} lane={lane} off />
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
}: {
  node: FlowNodeDef;
  installed: InstalledModule[];
  review: ReturnType<typeof useModuleReview>;
  lane: FlowLane;
  off: boolean;
}) {
  const own = node.moduleId ? installed.find((card) => card.id === node.moduleId) : undefined;
  const tags = FLOW_TAGS.filter(
    (tag) => tag.lane === lane && tag.nodeId === node.id && installed.some((card) => card.id === tag.moduleId && !card.system),
  );
  const place = (moduleId: string) => `${lane}:${node.id}:${moduleId}`;
  return (
    <div className={off ? 'node is-off' : 'node'} data-node={node.label} data-active={off ? 'false' : 'true'}>
      <div className="node-label">{node.label}</div>
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
