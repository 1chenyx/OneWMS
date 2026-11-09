import { Fragment } from 'react';
import { Alert, Card, Radio, Switch } from 'antd';
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
import {
  ALLOCATION_LABEL,
  allocationResult,
  expiredResult,
  readAllocation,
  readBlockExpired,
  readSpecified,
  specifiedResult,
  useOutboundRules,
  type AllocationRule,
  type OutboundRuleDraft,
  type SpecifiedRule,
} from './use-outbound-rules';

/**
 * 流程。两张流程图。
 * 可选步骤是方块上的开关，关掉后箭头绕过它。
 * 拣货占用、短收短发、单据冲销只是方块上的开关，不另加方块。
 */

const PAGE_STYLE = `
.flow-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1;
  min-height: 0;
  width: 100%;
}
.flow-body {
  max-width: 920px;
}
.lane-title {
  margin: 4px 0 10px;
  font-weight: 600;
}
.lane + .lane {
  margin-top: 28px;
}
.chart {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 10px 0;
}
.node {
  min-width: 96px;
  padding: 10px 12px;
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
  flex-direction: column;
  align-items: center;
  min-width: 48px;
  padding: 14px 8px 0;
}
.edge-arrow {
  color: #1677ff;
  font-size: 18px;
  line-height: 1;
}
.edge .node {
  margin-top: 8px;
}
.outbound-rules {
  margin-top: 16px;
  padding: 12px 14px;
  border: 1px solid #f0f0f0;
  border-radius: 10px;
  background: #fff;
}
.outbound-rules h3 {
  margin: 0;
  font-size: 14px;
}
.rules-note {
  margin: 4px 0 12px;
  color: rgba(0, 0, 0, 0.45);
  font-size: 13px;
}
.rules-label {
  margin-bottom: 8px;
  font-weight: 600;
}
.rules-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rules-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}
`;

export default function FlowsPage() {
  const review = useModuleReview('流程');
  const rules = useOutboundRules();
  const { snapshotQuery, snapshot, installed } = review;

  return (
    <div className="flow-page">
      <style>{PAGE_STYLE}</style>
      <PageHeader title="流程" subtitle="拨方块上的开关，箭头就改道。出库怎么扣批次也在下面。确认后才生效。" />
      {snapshotQuery.isError ? (
        <Alert type="error" showIcon message="读不到流程配置" />
      ) : snapshotQuery.isLoading || !snapshot ? (
        <Card loading />
      ) : (
        <div className="flow-body">
          <Lane lane="inbound" installed={installed} review={review} locked={rules.busy} />
          <Lane lane="outbound" installed={installed} review={review} locked={rules.busy} rules={rules} />
        </div>
      )}
    </div>
  );
}

function Lane({
  lane,
  installed,
  review,
  locked,
  rules,
}: {
  lane: FlowLane;
  installed: InstalledModule[];
  review: ReturnType<typeof useModuleReview>;
  locked: boolean;
  rules?: ReturnType<typeof useOutboundRules>;
}) {
  const nodes = FLOW_NODES.filter((node) => node.lane === lane).filter(
    (node) => !node.moduleId || installed.some((card) => card.id === node.moduleId && !card.system),
  );
  const active = (node: FlowNodeDef) => !node.moduleId || moduleOn(installed, node.moduleId, review.preview);
  const live = nodes.filter(active);

  return (
    <section className="lane" aria-label={laneTitle(lane)}>
      <div className="lane-title">{laneTitle(lane)}</div>
      <div className="chart" data-testid={`${lane}-chart`}>
        {live.map((node, index) => {
          const prev = live[index - 1];
          const skipped = prev ? nodesBetween(nodes, prev, node).filter((item) => !active(item)) : [];
          return (
            <Fragment key={`${lane}-${node.id}`}>
              {prev ? (
                <Edge from={prev.label} to={node.label} skipped={skipped} installed={installed} review={review} lane={lane} locked={locked} />
              ) : null}
              <FlowBox node={node} installed={installed} review={review} lane={lane} off={false} locked={locked} />
            </Fragment>
          );
        })}
      </div>
      {lane === 'outbound' && rules ? (
        <OutboundRulesCard
          settings={review.snapshot?.modules['core.wms']?.settings}
          rules={rules}
          locked={review.busy}
          nameOf={review.nameOf}
        />
      ) : null}
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
  locked,
}: {
  from: string;
  to: string;
  skipped: FlowNodeDef[];
  installed: InstalledModule[];
  review: ReturnType<typeof useModuleReview>;
  lane: FlowLane;
  locked: boolean;
}) {
  return (
    <div className="edge" data-from={from} data-to={to}>
      <span className="edge-arrow" aria-hidden="true">
        →
      </span>
      {skipped.map((node) => (
        <FlowBox key={node.id} node={node} installed={installed} review={review} lane={lane} off locked={locked} />
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
  locked,
}: {
  node: FlowNodeDef;
  installed: InstalledModule[];
  review: ReturnType<typeof useModuleReview>;
  lane: FlowLane;
  off: boolean;
  locked: boolean;
}) {
  const own = node.moduleId ? installed.find((card) => card.id === node.moduleId) : undefined;
  const tags = FLOW_TAGS.filter(
    (tag) => tag.lane === lane && tag.nodeId === node.id && installed.some((card) => card.id === tag.moduleId && !card.system),
  );
  const place = (moduleId: string) => `${lane}:${node.id}:${moduleId}`;
  return (
    <div className={off ? 'node is-off' : 'node'} data-node={node.label} data-active={off ? 'false' : 'true'}>
      <div className="node-label">{node.label}</div>
      {own && node.moduleId ? (
        <NodeSwitch
          card={own}
          label={node.label}
          place={place(node.moduleId)}
          review={review}
          locked={locked}
        />
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
            locked={locked}
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
  locked,
}: {
  card: InstalledModule;
  label: string;
  place: string;
  review: ReturnType<typeof useModuleReview>;
  locked: boolean;
}) {
  const on = shownEnabled(card, review.preview);
  return (
    <>
      <div className="node-switch">
        <Switch
          aria-label={label}
          checked={on}
          disabled={review.busy || locked}
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
  locked,
}: {
  tag: FlowTagDef;
  nodeLabel: string;
  card: InstalledModule;
  place: string;
  review: ReturnType<typeof useModuleReview>;
  locked: boolean;
}) {
  const on = shownEnabled(card, review.preview);
  return (
    <>
      <div className="node-switch">
        <span>{tag.label}</span>
        <Switch
          aria-label={`${nodeLabel}：${tag.label}`}
          checked={on}
          disabled={review.busy || locked}
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

function OutboundRulesCard({
  settings,
  rules,
  locked,
  nameOf,
}: {
  settings: Record<string, unknown> | undefined;
  rules: ReturnType<typeof useOutboundRules>;
  locked: boolean;
  nameOf: (id: string) => string;
}) {
  const savedAllocation = readAllocation(settings);
  const savedExpired = readBlockExpired(settings);
  const savedBatch = readSpecified(settings, 'specifiedBatchConstraint');
  const savedLocation = readSpecified(settings, 'specifiedLocationConstraint');
  const allocation = rules.preview?.allocation ?? savedAllocation;
  const blockExpired = rules.preview?.blockExpired ?? savedExpired;
  const batchConstraint = rules.preview?.batchConstraint ?? savedBatch;
  const locationConstraint = rules.preview?.locationConstraint ?? savedLocation;
  const disabled = rules.busy || locked;
  const base = (): Omit<OutboundRuleDraft, 'place' | 'text'> => ({
    allocation: savedAllocation,
    blockExpired: savedExpired,
    batchConstraint: savedBatch,
    locationConstraint: savedLocation,
  });
  return (
    <div className="outbound-rules">
      <h3>出库规则</h3>
      <p className="rules-note">这里是仓库缺省。一张出库单可以另选怎么扣，以及写了的批次、库位能不能换。</p>
      <div className="rules-label">批次怎么扣</div>
      <Radio.Group
        name="outbound-allocation"
        aria-label="批次怎么扣"
        value={allocation}
        disabled={disabled}
        onChange={(event) => {
          const value = event.target.value as AllocationRule;
          if (value === (rules.preview?.allocation ?? savedAllocation)) return;
          void rules.start(
            {
              ...base(),
              allocation: value,
              place: 'outbound:allocation',
              text: allocationResult(value),
            },
            `出库改为${ALLOCATION_LABEL[value]}`,
            '/modules/core.wms/settings/defaultAllocation',
            value,
          );
        }}
      >
        <div className="rules-options">
          <Radio value="strict">严格桶。没写批次只扣默认批次。</Radio>
          <Radio value="fifo">先进先出。按先入库的批次扣。</Radio>
          <Radio value="fefo">先到期先出。先扣快过期的，没有效期的放最后。</Radio>
        </div>
      </Radio.Group>
      <div className="rules-switch">
        <Switch
          aria-label="过期批次不能出"
          checked={blockExpired}
          disabled={disabled}
          onChange={(on) => {
            void rules.start(
              {
                ...base(),
                blockExpired: on,
                place: 'outbound:expired',
                text: expiredResult(on),
              },
              on ? '打开过期批次拦截' : '关掉过期批次拦截',
              '/modules/core.wms/settings/blockExpiredOutbound',
              on,
            );
          }}
        />
        <span>过期批次不能出。今天到期的还可以出。</span>
      </div>
      <SpecifiedChoice
        name="outbound-batch"
        label="写了批次之后"
        group="指定批次"
        value={batchConstraint}
        disabled={disabled}
        onChange={(value) => {
          void rules.start(
            {
              ...base(),
              batchConstraint: value,
              place: 'outbound:batch',
              text: specifiedResult('批次', value),
            },
            value === 'lock' ? '指定批次改为不能换' : '指定批次改为可以换',
            '/modules/core.wms/settings/specifiedBatchConstraint',
            value,
          );
        }}
      />
      <SpecifiedChoice
        name="outbound-location"
        label="写了库位之后"
        group="指定库位"
        value={locationConstraint}
        disabled={disabled}
        onChange={(value) => {
          void rules.start(
            {
              ...base(),
              locationConstraint: value,
              place: 'outbound:location',
              text: specifiedResult('库位', value),
            },
            value === 'lock' ? '指定库位改为不能换' : '指定库位改为可以换',
            '/modules/core.wms/settings/specifiedLocationConstraint',
            value,
          );
        }}
      />
      {rules.preview ? (
        <ChangeConfirm
          text={rules.preview.text}
          report={rules.report}
          confirming={rules.confirming}
          onDismiss={rules.dismiss}
          onApply={() => void rules.apply()}
          nameOf={nameOf}
        />
      ) : null}
    </div>
  );
}

function SpecifiedChoice({
  name,
  label,
  group,
  value,
  disabled,
  onChange,
}: {
  name: string;
  label: string;
  group: string;
  value: SpecifiedRule;
  disabled: boolean;
  onChange: (value: SpecifiedRule) => void;
}) {
  return (
    <div style={{ marginTop: 14 }}>
      <div className="rules-label">{label}</div>
      <Radio.Group
        name={name}
        aria-label={group}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as SpecifiedRule)}
      >
        <div className="rules-options">
          <Radio value="prefer">{group}可以换。拣货可以改。</Radio>
          <Radio value="lock">{group}不能换。只能按单据上写的出。</Radio>
        </div>
      </Radio.Group>
    </div>
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
