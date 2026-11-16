import { SCAN_PRESETS, ZEBRA_ACTION_HINT } from '../scan/presets.js';
import { useScanConsole } from '../scan/ScanProvider.js';
import { useFieldSession } from '../session.js';

export function ScanSettings() {
  const session = useFieldSession();
  const scan = session.store.prefs.scan;
  const consoleScan = useScanConsole();
  const selected = SCAN_PRESETS.find((preset) => preset.action === scan.broadcastAction && preset.extra === scan.broadcastExtra);

  return (
    <>
    <section className="field-group" aria-label="输入方式">
      <h2 className="field-label">输入方式</h2>
      <button
        type="button"
        className="field-choice"
        aria-pressed={scan.wedge}
        onClick={() => session.patchPrefs({ scan: { wedge: !scan.wedge } })}
      >
        {scan.wedge ? '键盘楔入 开' : '键盘楔入 关'}
      </button>
      <button
        type="button"
        className="field-choice"
        aria-pressed={scan.broadcast}
        onClick={() => session.patchPrefs({ scan: { broadcast: !scan.broadcast } })}
      >
        {scan.broadcast ? '广播 开' : '广播 关'}
      </button>
      <button type="button" className="field-choice" disabled>
        相机还没装
      </button>
    </section>
    <section className="field-group" aria-label="广播">
      <h2 className="field-label">广播</h2>
      <div className="field-segment field-segment-wrap" role="group" aria-label="广播预置">
        {SCAN_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={selected?.id === preset.id ? 'is-current' : undefined}
            aria-pressed={selected?.id === preset.id}
            onClick={() => session.patchPrefs({ scan: { broadcastAction: preset.action, broadcastExtra: preset.extra } })}
          >
            {preset.name}
          </button>
        ))}
      </div>
      <label className="field-label" htmlFor="field-broadcast-action">
        广播 action
      </label>
      <input
        id="field-broadcast-action"
        className="field-input"
        autoCapitalize="none"
        autoCorrect="off"
        value={scan.broadcastAction}
        onChange={(event) => session.patchPrefs({ scan: { broadcastAction: event.target.value } })}
      />
      {scan.broadcastAction.trim() === '' ? <p className="field-hint">{ZEBRA_ACTION_HINT}</p> : null}
      <label className="field-label" htmlFor="field-broadcast-extra">
        广播 extra
      </label>
      <input
        id="field-broadcast-extra"
        className="field-input field-mono"
        autoCapitalize="none"
        autoCorrect="off"
        value={scan.broadcastExtra}
        onChange={(event) => session.patchPrefs({ scan: { broadcastExtra: event.target.value } })}
      />
      <button
        type="button"
        className="field-secondary"
        onClick={() => void (consoleScan.probe ? consoleScan.stopProbe() : consoleScan.startProbe())}
      >
        {consoleScan.probe ? '停止监听' : '广播测试'}
      </button>
      {consoleScan.probe ? (
        <p className="field-mono" aria-live="polite">
          {consoleScan.lastBroadcast ?? '等一次扫码'}
        </p>
      ) : null}
    </section>
    </>
  );
}
