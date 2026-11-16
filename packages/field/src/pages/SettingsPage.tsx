import { useState, type ReactNode } from 'react';
import { useScanConsole } from '../scan/ScanProvider.js';
import { FIELD_VERSION } from '../version.js';
import { useFieldSession } from '../session.js';
import { ScanSettings } from './ScanSettings.js';

type Pane = 'home' | 'link' | 'device' | 'scan' | 'feedback' | 'about';

export function SettingsPage() {
  const session = useFieldSession();
  const scanLog = useScanConsole();
  const [address, setAddress] = useState(session.store.connection?.baseUrl ?? '');
  const [pane, setPane] = useState<Pane>('home');
  const mode = session.store.prefs.mode;
  const scan = session.store.prefs.scan;
  const online = session.online ? (session.link === 'platform' ? '已连接 · 平台' : '已连接') : '未连接';

  if (pane === 'link') {
    return (
      <main className="field-main">
        <PaneFrame title="连接" onBack={() => setPane('home')}>
          <section className="field-group" aria-label="连接">
            <p className="field-label">状态</p>
            <p>{online}</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void session.reconnect(address);
              }}
            >
              <label className="field-label" htmlFor="field-server-edit">
                服务器地址
              </label>
              <input
                id="field-server-edit"
                className="field-input"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
              />
              <button className="field-primary" type="submit" disabled={session.pending || address.trim() === ''}>
                {session.pending ? '正在连接' : '重新连接'}
              </button>
            </form>
            {session.error ? (
              <p className="field-error" role="alert">
                {session.error}
              </p>
            ) : null}
            {session.link === 'platform' ? (
              <button className="field-secondary" type="button" onClick={() => void session.logoutPlatform()}>
                退出平台
              </button>
            ) : null}
            <p className="field-kv">
              <span>工作区</span>
              <span className="field-mono">{session.health?.workspaceId ?? '—'}</span>
            </p>
            <p className="field-kv">
              <span>节点</span>
              <span className="field-mono">{session.health?.nodeId ?? '—'}</span>
            </p>
          </section>
        </PaneFrame>
      </main>
    );
  }

  if (pane === 'device') {
    return (
      <main className="field-main">
        <PaneFrame title="这台手机" onBack={() => setPane('home')}>
          <p className="field-kicker">现场做收货和上架。管理只看看板和库存。换人时在这里改。</p>
          <div className="field-segment" role="group" aria-label="这台机器给谁用">
            <button
              type="button"
              className={mode === 'floor' ? 'is-current' : undefined}
              aria-pressed={mode === 'floor'}
              onClick={() => session.setMode('floor')}
            >
              现场
            </button>
            <button
              type="button"
              className={mode === 'manage' ? 'is-current' : undefined}
              aria-pressed={mode === 'manage'}
              onClick={() => session.setMode('manage')}
            >
              管理
            </button>
          </div>
        </PaneFrame>
      </main>
    );
  }

  if (pane === 'scan') {
    return (
      <main className="field-main">
        <PaneFrame title="扫码" onBack={() => setPane('home')}>
          <ScanSettings />
          <label className="field-label" htmlFor="field-scan-log">
            最近扫码
          </label>
          <textarea id="field-scan-log" className="field-input field-log" readOnly rows={4} value={scanLog.log} placeholder="还没有扫码" />
        </PaneFrame>
      </main>
    );
  }

  if (pane === 'feedback') {
    return (
      <main className="field-main">
        <PaneFrame title="提示" onBack={() => setPane('home')}>
          <p className="field-kicker">扫对或扫错时用。关掉就不出声、不震动。</p>
          <section className="field-group">
            <button
              type="button"
              className="field-choice"
              aria-pressed={session.store.prefs.sound}
              onClick={() => session.patchPrefs({ sound: !session.store.prefs.sound })}
            >
              {session.store.prefs.sound ? '声音 开' : '声音 关'}
            </button>
            <button
              type="button"
              className="field-choice"
              aria-pressed={session.store.prefs.vibrate}
              onClick={() => session.patchPrefs({ vibrate: !session.store.prefs.vibrate })}
            >
              {session.store.prefs.vibrate ? '震动 开' : '震动 关'}
            </button>
          </section>
        </PaneFrame>
      </main>
    );
  }

  if (pane === 'about') {
    return (
      <main className="field-main">
        <PaneFrame title="关于" onBack={() => setPane('home')}>
          <section className="field-group">
            <p className="field-label">版本</p>
            <p>现场端 {FIELD_VERSION}</p>
          </section>
        </PaneFrame>
      </main>
    );
  }

  return (
    <main className="field-main">
      <div className="field-menu">
        <MenuRow label="连接" meta={online} onClick={() => setPane('link')} />
        <MenuRow label="这台手机" meta={mode === 'floor' ? '现场' : '管理'} onClick={() => setPane('device')} />
        <MenuRow
          label="扫码"
          meta={`键盘楔入 ${scan.wedge ? '开' : '关'} · 广播 ${scan.broadcast ? '开' : '关'}`}
          onClick={() => setPane('scan')}
        />
        <MenuRow
          label="提示"
          meta={`声音 ${session.store.prefs.sound ? '开' : '关'} · 震动 ${session.store.prefs.vibrate ? '开' : '关'}`}
          onClick={() => setPane('feedback')}
        />
        <MenuRow label="关于" meta={`现场端 ${FIELD_VERSION}`} onClick={() => setPane('about')} />
      </div>
    </main>
  );
}

function MenuRow({ label, meta, onClick }: { label: string; meta: string; onClick(): void }) {
  return (
    <button type="button" className="field-menu-row" aria-label={label} onClick={onClick}>
      <span className="field-launch-title">{label}</span>
      <span className="field-meta">{meta}</span>
    </button>
  );
}

function PaneFrame({ title, onBack, children }: { title: string; onBack(): void; children: ReactNode }) {
  return (
    <>
      <button type="button" className="field-back" onClick={onBack}>
        返回
      </button>
      <h2 className="field-pane-title">{title}</h2>
      {children}
    </>
  );
}
