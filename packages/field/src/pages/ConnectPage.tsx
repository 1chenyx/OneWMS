import { useState } from 'react';
import { useFieldSession } from '../session.js';

function roleLabel(role: string): string {
  if (role === 'owner') return '所有者';
  if (role === 'admin') return '管理员';
  if (role === 'clerk') return '作业员';
  if (role === 'viewer') return '只读';
  return role;
}

export function ConnectPage() {
  const session = useFieldSession();
  const saved = session.store.connection?.baseUrl ?? '';
  const [address, setAddress] = useState(saved);
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  if (session.platform?.need === 'workspace') {
    return (
      <main className="field-main field-gate">
        <p className="field-brand">OneWMS</p>
        <h1 className="field-title">选择工作区</h1>
        {session.error ? (
          <p className="field-error" role="alert">
            {session.error}
          </p>
        ) : null}
        {session.platform.memberships.map((row) => (
          <button
            key={row.workspaceId}
            className="field-choice"
            type="button"
            disabled={session.pending}
            onClick={() => void session.chooseWorkspace(row.workspaceId)}
          >
            <span className="field-mono">{row.name}</span>
            {row.role ? <span className="field-meta">{roleLabel(row.role)}</span> : null}
          </button>
        ))}
      </main>
    );
  }

  if (session.platform?.need === 'login') {
    return (
      <main className="field-main field-gate">
        <p className="field-brand">OneWMS</p>
        <h1 className="field-title">登录平台</h1>
        <p className="field-mono">{address}</p>
        {session.error ? (
          <p className="field-error" role="alert">
            {session.error}
          </p>
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void session.login(email, password).then(() => setPassword(''));
          }}
        >
          <label className="field-label" htmlFor="field-platform-email">
            平台邮箱
          </label>
          <input
            id="field-platform-email"
            className="field-input"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <label className="field-label" htmlFor="field-platform-secret">
            平台密码
          </label>
          <input
            id="field-platform-secret"
            className="field-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button className="field-primary" type="submit" disabled={session.pending}>
            {session.pending ? '正在登录' : '登录'}
          </button>
        </form>
        <button
          className="field-secondary"
          type="button"
          onClick={() => {
            setPassword('');
            session.cancelPlatform();
            setEditing(true);
          }}
        >
          改地址
        </button>
      </main>
    );
  }

  const showError = Boolean(session.error) && !editing;

  return (
    <main className="field-main field-gate">
      <p className="field-brand">OneWMS</p>
      <h1 className="field-title">连接仓库</h1>
      {showError ? (
        <>
          <p className="field-error" role="alert">
            {session.error}
          </p>
          <button className="field-primary" type="button" disabled={session.pending} onClick={() => void session.connect(address)}>
            重试
          </button>
          <button className="field-secondary" type="button" onClick={() => setEditing(true)}>
            改地址
          </button>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void session.connect(address).then(() => setEditing(false));
          }}
        >
          <label className="field-label" htmlFor="field-server">
            服务器地址
          </label>
          <input
            id="field-server"
            className="field-input"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="http://192.168.1.20:3000"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
          <p className="field-kicker">电脑上预览时填 http://127.0.0.1:3000。服务若是平台，下一屏再登录。</p>
          {session.error ? (
            <p className="field-error" role="alert">
              {session.error}
            </p>
          ) : null}
          <button className="field-primary" type="submit" disabled={session.pending || address.trim() === ''}>
            {session.pending ? '正在连接' : '连接'}
          </button>
        </form>
      )}
    </main>
  );
}
