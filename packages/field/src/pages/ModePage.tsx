import { useFieldSession } from '../session.js';

export function ModePage() {
  const session = useFieldSession();
  if (!session.health || !session.snapshot) return null;
  return (
    <main className="field-main field-gate">
      <p className="field-brand">OneWMS</p>
      <h1 className="field-title">这台手机用来</h1>
      <p className="field-kicker">
        {session.link === 'platform' ? '平台账号已经登录。选这台手机的用法。' : '选一种用法。之后在设置里可以改。'}
      </p>
      <button className="field-launch is-suggested" type="button" aria-label="现场作业" onClick={() => session.chooseMode('floor')}>
        <span className="field-launch-title">现场作业</span>
        <span className="field-meta">收货、上架</span>
      </button>
      <button className="field-launch" type="button" aria-label="看仓库" onClick={() => session.chooseMode('manage')}>
        <span className="field-launch-title">看仓库</span>
        <span className="field-meta">看板、库存</span>
      </button>
      <section className="field-card field-identity" aria-label="已连接">
        <span className="field-kicker">已连接</span>
        <span className="field-meta">工作区</span>
        <span className="field-mono">{session.health.workspaceId}</span>
        <span className="field-meta">{session.health.nodeId}</span>
      </section>
    </main>
  );
}
