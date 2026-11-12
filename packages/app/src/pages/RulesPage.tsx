import { Alert, Card, Radio, Switch } from 'antd';
import PageHeader from '../components/PageHeader';
import { presentOf } from '../lib/module-present';
import { useProfileCatalog, useProfileSnapshot } from '../api/hooks';
import ChangeConfirm from './ChangeConfirm';
import NumberingRulesCard from './NumberingRulesCard';
import { useNumberingRules } from './use-numbering-rules';
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
 * 规则。出库怎么扣、各处编号怎么编，都在这里定。
 * 出库单不再另选批次怎么扣，也不另选写了的批次、库位能不能换。
 */

const PAGE_STYLE = `
.rules-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1;
  min-height: 0;
  width: 100%;
}
.rules-body {
  max-width: 880px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.outbound-rules {
  padding: 14px 16px;
  border: 1px solid #f0f0f0;
  border-radius: 10px;
  background: #fff;
}
.outbound-rules h3 {
  margin: 0;
  font-size: 16px;
}
.rules-note {
  margin: 4px 0 12px;
  color: rgba(0, 0, 0, 0.45);
  font-size: 13px;
}
.rules-label {
  margin-bottom: 8px;
  font-weight: 500;
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

export default function RulesPage() {
  const snapshot = useProfileSnapshot();
  const catalog = useProfileCatalog();
  const outbound = useOutboundRules();
  const numbering = useNumberingRules();
  const nameOf = (id: string) => catalog.data?.modules.find((item) => item.id === id)?.name ?? presentOf(id).name;
  const settings = snapshot.data?.modules['core.wms']?.settings;

  return (
    <div className="rules-page">
      <style>{PAGE_STYLE}</style>
      <PageHeader title="规则" subtitle="出库怎么扣、各处编号怎么编，都在这里定。确认后才生效。" />
      {snapshot.isError ? (
        <Alert type="error" showIcon message="读不到规则配置" />
      ) : snapshot.isLoading || !snapshot.data ? (
        <Card loading />
      ) : (
        <div className="rules-body">
          <OutboundRulesCard settings={settings} rules={outbound} locked={numbering.busy} nameOf={nameOf} />
          <NumberingRulesCard settings={settings} rules={numbering} locked={outbound.busy} nameOf={nameOf} />
        </div>
      )}
    </div>
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
      <p className="rules-note">整仓同一套。在这里改，或让助手改。新建出库单按这里的配置出，单上不再另选。</p>
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
