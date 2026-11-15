import { Checkbox } from 'antd';
import { readEnabledZoneKinds, ZONE_KINDS, zoneKindUseText, type ZoneKind } from '@one/wms/zone-kinds';
import ChangeConfirm from './ChangeConfirm';
import {
  savedZoneKinds,
  useZoneKindRules,
  zoneKindChangeNote,
  zoneKindChangeText,
  zoneKindPatch,
} from './use-zone-kind-rules';

/**
 * 这个工作区启用哪些库区分类。关掉的不能新建，也不再限制作业。
 */

function sameKinds(left: readonly ZoneKind[], right: readonly ZoneKind[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export default function ZoneKindRulesCard({
  settings,
  rules,
  locked,
  nameOf,
}: {
  settings: Record<string, unknown> | undefined;
  rules: ReturnType<typeof useZoneKindRules>;
  locked: boolean;
  nameOf: (id: string) => string;
}) {
  const saved = savedZoneKinds(settings);
  const selected = rules.preview?.kinds ?? saved;
  const disabled = rules.busy || locked;
  return (
    <div className="zone-kind-rules">
      <h3>库区分类</h3>
      <p className="rules-note">勾选这个工作区要用的分类。关掉的分类不能新建，也不再限制作业；已经建好的库区还在。没勾过时，八种都启用。</p>
      <Checkbox.Group
        aria-label="启用的库区分类"
        value={selected}
        disabled={disabled}
        onChange={(values) => {
          const next = readEnabledZoneKinds(values);
          if (sameKinds(next, selected)) return;
          void rules.start({
            kinds: next,
            text: zoneKindChangeText(saved, next),
            note: zoneKindChangeNote(saved, next),
            patch: zoneKindPatch(settings, next),
          });
        }}
      >
        <div className="rules-options">
          {ZONE_KINDS.map((kind) => (
            <Checkbox key={kind.id} value={kind.id}>
              {kind.label}。{zoneKindUseText(kind.id)}
            </Checkbox>
          ))}
        </div>
      </Checkbox.Group>
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
