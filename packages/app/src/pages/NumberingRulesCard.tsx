import { useMemo, useRef, useState } from 'react';
import { Button, Input } from 'antd';
import {
  NUMBERING_PLACES,
  RESET_LABEL,
  readNumbering,
  sampleNumber,
} from '@one/wms/numbering';
import ChangeConfirm from './ChangeConfirm';
import { useNumberingRules } from './use-numbering-rules';

/**
 * 各处编号模板。本地草稿即时出示例（序号取 1），提交走提议确认。
 * 没存过 numbering 时用 add；已经有键时用 replace。整对象提交。
 */

const STYLE = `
.numbering-rules h3 {
  margin: 0;
  font-size: 16px;
}
.numbering-group {
  margin: 14px 0 4px;
  font-weight: 500;
}
.numbering-row {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: 4px 12px;
  align-items: start;
  margin-top: 10px;
}
.numbering-sample {
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
}
.numbering-error {
  color: #cf1322;
  font-size: 12px;
}
.numbering-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}
`;

function patternsFrom(settings: Record<string, unknown> | undefined): Record<string, string> {
  const rules = readNumbering(settings);
  const out: Record<string, string> = {};
  for (const place of NUMBERING_PLACES) {
    const row = rules.byId[place.id];
    out[place.id] = row.configured ?? row.pattern;
  }
  return out;
}

function numberingPatch(settings: Record<string, unknown> | undefined, value: Record<string, string>) {
  if (!settings) {
    return [{ op: 'add' as const, path: '/modules/core.wms/settings', value: { numbering: value } }];
  }
  const rules = readNumbering(settings);
  return [{ op: rules.patchOp, path: '/modules/core.wms/settings/numbering', value }];
}

export default function NumberingRulesCard({
  settings,
  rules,
  locked,
  nameOf,
}: {
  settings: Record<string, unknown> | undefined;
  rules: ReturnType<typeof useNumberingRules>;
  locked: boolean;
  nameOf: (id: string) => string;
}) {
  const saved = useMemo(() => patternsFrom(settings), [settings]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const seenGen = useRef(rules.generation);
  if (seenGen.current !== rules.generation) {
    seenGen.current = rules.generation;
    setEdits({});
  }
  const shown = { ...saved, ...edits };
  const changed = NUMBERING_PLACES.filter((place) => (shown[place.id] ?? '').trim() !== saved[place.id].trim());
  const invalid = NUMBERING_PLACES.some((place) => !sampleNumber(shown[place.id] ?? '').ok);
  const disabled = rules.busy || locked;

  const submit = () => {
    if (changed.length === 0 || invalid || disabled) return;
    const value: Record<string, string> = {};
    for (const place of NUMBERING_PLACES) value[place.id] = (shown[place.id] ?? '').trim();
    const bits = changed.map((place) => {
      const sample = sampleNumber(value[place.id] ?? '');
      const how = sample.ok ? `${RESET_LABEL[sample.reset]}，例如 ${sample.sample}` : '';
      return `${place.label}改为 ${value[place.id]}（${how}）`;
    });
    void rules.start({
      text: `${bits.join('。')}。已经存在的编号不变。`,
      note: `编号 ${changed.map((place) => place.label).join('、')}`,
      patch: numberingPatch(settings, value),
    });
  };

  return (
    <div className="outbound-rules numbering-rules">
      <style>{STYLE}</style>
      <h3>编号规则</h3>
      <p className="rules-note">
        每一处一张模板。新建时先填好下一号，可以改。留空则保存时再按这里生成。确认后才生效，也可以让助手设计。
      </p>
      {(['作业', '档案'] as const).map((group) => (
        <div key={group}>
          <div className="numbering-group">{group}</div>
          {NUMBERING_PLACES.filter((place) => place.group === group).map((place) => {
            const source = shown[place.id] ?? '';
            const sample = sampleNumber(source);
            return (
              <div className="numbering-row" key={place.id}>
                <label htmlFor={`numbering-${place.id}`}>{place.label}</label>
                <div>
                  <Input
                    id={`numbering-${place.id}`}
                    aria-label={`${place.label}编号模板`}
                    value={source}
                    disabled={disabled}
                    onChange={(event) => setEdits((prev) => ({ ...prev, [place.id]: event.target.value }))}
                    spellCheck={false}
                  />
                  {sample.ok ? (
                    <div className="numbering-sample">
                      {RESET_LABEL[sample.reset]}，例如 {sample.sample}
                    </div>
                  ) : (
                    <div className="numbering-error">{sample.error}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
      <div className="numbering-actions">
        <Button type="primary" disabled={changed.length === 0 || invalid || disabled} onClick={submit}>
          提交编号规则
        </Button>
      </div>
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
