import { useState, type ReactNode } from 'react';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { bootstrap, login, useAuthStatus, useSession, useSessionUser } from '../api/auth';
import { ApiError } from '../api/request';
import { readSessionToken } from '../lib/session';

/**
 * 登录门（module.rbac）。
 *
 * 三种状态：
 *  - 模块停用（默认）→ 直接放行，界面和从前一模一样，一个字都不多；
 *  - 启用但一个账号都没有 → 显示「建第一个仓库经理」表单（POST /api/auth/bootstrap，
 *    建完这条通道就关了，之后只能由管理员建人）；
 *  - 启用且已有账号 → 显示登录表单。
 *
 * 令牌存在 localStorage，刷新页面后 AuthGate 会带旧令牌打一次 /api/auth/me
 * 把登录态接回来；会话过期（401）时 request 层已清掉本地态，这里重新显示登录。
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  const { data: status, isLoading } = useAuthStatus();
  const { user } = useSession();
  const [bootstrapped, setBootstrapped] = useState(false);
  // 刷新页面后把上次的登录态接回来；令牌已死（401）时 request 层会清掉本地态，
  // 这里 query 失败也不重试，直接落回登录表单。
  useSessionUser(Boolean(status?.enabled) && user === null && readSessionToken() !== null);

  if (isLoading || status === undefined) {
    // 状态还没问回来就先别渲染主界面：否则一堆请求会以未登录身份打出去，全吃 401
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Typography.Text type="secondary">正在确认登录方式…</Typography.Text>
      </div>
    );
  }

  if (!status.enabled) return <>{children}</>;
  if (user !== null) return <>{children}</>;

  const needsBootstrap = !status.bootstrapped && !bootstrapped;
  return <AuthForm bootstrapMode={needsBootstrap} onBootstrapped={() => setBootstrapped(true)} />;
}

/** 登录 / 首次建号表单。两者字段一样，只差提交打哪个端点、标题怎么写。 */
function AuthForm({
  bootstrapMode,
  onBootstrapped,
}: {
  bootstrapMode: boolean;
  onBootstrapped: () => void;
}) {
  const [form] = Form.useForm<{ username: string; displayName?: string; password: string }>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 建完第一个账号不自动登录：让他自己走一遍登录，顺便验证账号真的能用
  const [done, setDone] = useState(false);

  const submit = async () => {
    setError(null);
    let values: { username: string; displayName?: string; password: string };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setBusy(true);
    try {
      if (bootstrapMode) {
        await bootstrap(values);
        onBootstrapped();
        setDone(true);
      } else {
        await login(values.username, values.password);
        // 登录成功后整个门会自己消失（session 单例变了 → 上层重渲染），不用手动跳
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '登录失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Shell>
        <Alert
          type="success"
          showIcon
          message="仓库经理账号已建好"
          description="现在用刚建的账号登录。登录进去后到「系统 → 用户与角色」给其他人建账号。"
        />
        <Button type="primary" block style={{ marginTop: 16 }} onClick={() => setDone(false)}>
          去登录
        </Button>
      </Shell>
    );
  }

  return (
    <Shell>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        {bootstrapMode ? '建第一个仓库经理' : '登录'}
      </Typography.Title>
      {bootstrapMode && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="这个库还没有账号"
          description="用户与角色刚启用。先建一个仓库经理：只有这个角色能确认配置变更，包括以后再把这个模块关掉。"
        />
      )}
      {!bootstrapMode && readSessionToken() === null && (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          本机启用了「用户与角色」，需要用账号登录后才能作业。
        </Typography.Paragraph>
      )}
      <Form form={form} layout="vertical" onFinish={() => void submit()}>
        <Form.Item
          name="username"
          label="账号"
          rules={[{ required: true, message: '请输入账号' }]}
        >
          <Input autoFocus autoComplete="username" placeholder="例如 manager" />
        </Form.Item>
        {bootstrapMode && (
          <Form.Item name="displayName" label="显示名">
            <Input placeholder="现场看得懂的名字，例如 张经理" />
          </Form.Item>
        )}
        <Form.Item
          name="password"
          label="口令"
          rules={[
            { required: true, message: '请输入口令' },
            { min: 6, message: '口令至少 6 位' },
          ]}
        >
          <Input.Password
            autoComplete={bootstrapMode ? 'new-password' : 'current-password'}
            placeholder="至少 6 位"
          />
        </Form.Item>
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
        <Button type="primary" htmlType="submit" block loading={busy}>
          {bootstrapMode ? '建号' : '登录'}
        </Button>
      </Form>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        overflow: 'auto',
      }}
    >
      <Card style={{ width: 380, maxWidth: '100%' }}>{children}</Card>
    </div>
  );
}
