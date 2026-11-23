import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  changeOwnPassword,
  logout,
  useAuthRoles,
  useAuthUsers,
  useCreateRole,
  useCreateUser,
  useDeleteRole,
  useDeleteUser,
  useSession,
  useUpdateRole,
  useUpdateUser,
} from '../api/auth';
import { ApiError } from '../api/request';

/**
 * 用户与角色页（module.rbac）。
 *
 * 导航里这一项挂了 moduleId，模块停用时整项不出现；这里再兜一层，
 * 免得有人从命令面板或 AI 跳转直接落到这个 page key 上。
 *
 * 两块内容：
 *  - 用户：谁能登录、挂哪个角色、启用还是停用；
 *  - 角色：四类权限对象（页面 / 工具读写 / 配置确认 / 报表导出）的授权模式清单。
 * 内置四个角色可以改授权但不能删——它是新用户的回落面。
 */

const GRANT_SUGGESTIONS = [
  '*',
  'page:*',
  'tool.read:*',
  'tool.write:*',
  'config.propose',
  'config.confirm',
  'report.export:*',
];

export default function UsersPage() {
  const { status, user } = useSession();
  const enabled = status.enabled;
  const users = useAuthUsers(enabled);
  const roles = useAuthRoles(enabled);
  const [userModal, setUserModal] = useState<null | { id?: string }>(null);
  const [roleModal, setRoleModal] = useState<null | { id?: string }>(null);
  const [passwordModal, setPasswordModal] = useState(false);

  if (!enabled) {
    return (
      <Empty
        description={
          <span>
            「用户与角色」没有启用，现在是免登录单人作业。
            <br />
            要多人共用这台服务器，去「系统 → 模块」把它打开（需要慢通道确认）。
          </span>
        }
      />
    );
  }

  const roleName = (id: string) =>
    roles.data?.rows.find((role) => role.id === id)?.name ?? id;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small" title="当前登录">
        {user === null ? (
          <Typography.Text type="secondary">未登录</Typography.Text>
        ) : (
          <Descriptions size="small" column={4}>
            <Descriptions.Item label="账号">{user.username}</Descriptions.Item>
            <Descriptions.Item label="显示名">{user.displayName}</Descriptions.Item>
            <Descriptions.Item label="角色">
              <Tag color="blue">{user.roleName}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="操作">
              <Space>
                <Button size="small" onClick={() => setPasswordModal(true)}>
                  改口令
                </Button>
                <Button size="small" danger onClick={() => void logout()}>
                  退出登录
                </Button>
              </Space>
            </Descriptions.Item>
          </Descriptions>
        )}
      </Card>

      <Tabs
        items={[
          {
            key: 'users',
            label: `用户（${users.data?.total ?? 0}）`,
            children: (
              <Card
                size="small"
                title="谁能登录"
                extra={
                  <Button type="primary" size="small" onClick={() => setUserModal({})}>
                    新建用户
                  </Button>
                }
              >
                <Table
                  rowKey="id"
                  size="small"
                  loading={users.isLoading}
                  dataSource={users.data?.rows ?? []}
                  pagination={false}
                  columns={[
                    { title: '账号', dataIndex: 'username' },
                    { title: '显示名', dataIndex: 'displayName' },
                    {
                      title: '角色',
                      dataIndex: 'roleId',
                      render: (id: string) => <Tag>{roleName(id)}</Tag>,
                    },
                    { title: '所属节点', dataIndex: 'node', render: (v: string) => v || '—' },
                    {
                      title: '状态',
                      dataIndex: 'status',
                      render: (value: string) =>
                        value === 'active' ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>,
                    },
                    { title: '操作', key: 'ops', render: (_v, row) => <UserOps id={row.id} current={row.id === user?.id} username={row.username} active={row.status === 'active'} /> },
                  ]}
                />
              </Card>
            ),
          },
          {
            key: 'roles',
            label: `角色（${roles.data?.total ?? 0}）`,
            children: (
              <Card
                size="small"
                title="角色能干什么"
                extra={
                  <Button type="primary" size="small" onClick={() => setRoleModal({})}>
                    新建角色
                  </Button>
                }
              >
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="授权用模式串，* 是通配"
                  description="四类权限对象：page:{页面} / tool.read:{工具} 与 tool.write:{工具} / config.propose 与 config.confirm / report.export:{报表}。单独一条 * 表示全部。"
                />
                <Table
                  rowKey="id"
                  size="small"
                  loading={roles.isLoading}
                  dataSource={roles.data?.rows ?? []}
                  pagination={false}
                  columns={[
                    {
                      title: '角色',
                      dataIndex: 'name',
                      render: (name: string, row) => (
                        <Space>
                          {name}
                          {row.builtin && <Tag>内置</Tag>}
                        </Space>
                      ),
                    },
                    { title: '说明', dataIndex: 'description', ellipsis: true },
                    {
                      title: '授权',
                      dataIndex: 'grants',
                      render: (grants: string[]) => (
                        <Space size={[4, 4]} wrap>
                          {grants.map((grant) => (
                            <Tag key={grant} color={grant === '*' ? 'red' : undefined}>
                              {grant}
                            </Tag>
                          ))}
                        </Space>
                      ),
                    },
                    { title: '操作', key: 'ops', render: (_v, row) => <RoleOps id={row.id} builtin={row.builtin} onEdit={() => setRoleModal({ id: row.id })} /> },
                  ]}
                />
              </Card>
            ),
          },
        ]}
      />

      {userModal !== null && (
        <UserModal
          editing={userModal.id}
          onClose={() => setUserModal(null)}
          roles={roles.data?.rows ?? []}
        />
      )}
      {roleModal !== null && (
        <RoleModal editing={roleModal.id} onClose={() => setRoleModal(null)} roles={roles.data?.rows ?? []} />
      )}
      {passwordModal && <PasswordModal onClose={() => setPasswordModal(false)} />}
    </Space>
  );
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : '操作失败，请重试';
}

/** 单个用户行上的操作：改角色、停用/启用、重置口令、删除 */
function UserOps({
  id,
  username,
  active,
  current,
}: {
  id: string;
  username: string;
  active: boolean;
  current: boolean;
}) {
  const update = useUpdateUser();
  const remove = useDeleteUser();
  const text = errorText;
  const [resetting, setResetting] = useState(false);
  const [form] = Form.useForm<{ password: string }>();

  return (
    <Space size={4} wrap>
      <Switch
        size="small"
        checked={active}
        disabled={current || update.isPending}
        checkedChildren="启用"
        unCheckedChildren="停用"
        onChange={(next) =>
          update.mutate(
            { id, patch: { status: next ? 'active' : 'disabled' } },
            { onError: (err) => void message.error(text(err)) },
          )
        }
      />
      <Button size="small" onClick={() => setResetting(true)}>
        重置口令
      </Button>
      <Popconfirm
        title={`删掉 ${username}？`}
        description="历史记录保留，只是这个人不能再登录。"
        disabled={current}
        onConfirm={() =>
          remove.mutate(
            { id },
            {
              onError: (err) => void message.error(text(err)),
              onSuccess: () => void message.success('已删除'),
            },
          )
        }
      >
        <Button size="small" danger disabled={current}>
          删除
        </Button>
      </Popconfirm>
      <Modal
        title={`重置 ${username} 的口令`}
        open={resetting}
        okText="重置"
        confirmLoading={update.isPending}
        onCancel={() => setResetting(false)}
        onOk={() =>
          void form.validateFields().then((values) =>
            update.mutate(
              { id, patch: { password: values.password } },
              {
                onError: (err) => void message.error(text(err)),
                onSuccess: () => {
                  setResetting(false);
                  form.resetFields();
                  void message.success('口令已重置，他的其他登录会当场失效');
                },
              },
            ),
          )
        }
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="password"
            label="新口令"
            rules={[
              { required: true, message: '请输入新口令' },
              { min: 6, message: '口令至少 6 位' },
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

/** 单个角色行上的操作：改授权、删除（内置不可删） */
function RoleOps({ id, builtin, onEdit }: { id: string; builtin: boolean; onEdit: () => void }) {
  const remove = useDeleteRole();
  const text = errorText;
  return (
    <Space size={4}>
      <Button size="small" onClick={onEdit}>
        改授权
      </Button>
      <Popconfirm
        title="删掉这个角色？"
        disabled={builtin}
        onConfirm={() =>
          remove.mutate(
            { id },
            {
              onError: (err) => void message.error(text(err)),
              onSuccess: () => void message.success('已删除'),
            },
          )
        }
      >
        <Button size="small" danger disabled={builtin}>
          {builtin ? '内置不可删' : '删除'}
        </Button>
      </Popconfirm>
    </Space>
  );
}

interface RoleOption {
  id: string;
  name: string;
}

function UserModal({
  editing,
  onClose,
  roles,
}: {
  editing?: string;
  onClose: () => void;
  roles: readonly RoleOption[];
}) {
  const [form] = Form.useForm();
  const create = useCreateUser();
  const update = useUpdateUser();
  const text = errorText;
  const isEdit = editing !== undefined;

  return (
    <Modal
      title={isEdit ? '改用户' : '新建用户'}
      open
      okText={isEdit ? '保存' : '建号'}
      confirmLoading={create.isPending || update.isPending}
      onCancel={onClose}
      onOk={() =>
        void form.validateFields().then((values) => {
          const done = {
            onError: (err: unknown) => void message.error(text(err)),
            onSuccess: () => {
              onClose();
              void message.success(isEdit ? '已保存' : '账号已建好');
            },
          };
          if (isEdit) {
            const { username: _username, ...patch } = values as Record<string, unknown>;
            if (patch.password === '') delete patch.password;
            update.mutate({ id: editing, patch }, done);
            return;
          }
          create.mutate(values, done);
        })
      }
    >
      <Form form={form} layout="vertical" initialValues={{ roleId: 'role.worker' }}>
        <Form.Item
          name="username"
          label="账号"
          rules={[{ required: !isEdit, message: '请输入账号' }]}
          extra={isEdit ? '账号建好就不改了' : '字母数字和 ._@-，2-64 位'}
        >
          <Input disabled={isEdit} autoComplete="off" />
        </Form.Item>
        <Form.Item name="displayName" label="显示名">
          <Input placeholder="现场看得懂的名字" />
        </Form.Item>
        <Form.Item name="roleId" label="角色" rules={[{ required: true, message: '请选择角色' }]}>
          <Select
            options={roles.map((role) => ({ value: role.id, label: role.name }))}
            placeholder="选一个角色"
          />
        </Form.Item>
        <Form.Item name="node" label="所属节点" extra="局域网多人多节点时填，单人可留空">
          <Input />
        </Form.Item>
        <Form.Item
          name="password"
          label={isEdit ? '重置口令（留空则不改）' : '口令'}
          rules={isEdit ? [{ min: 6, message: '口令至少 6 位' }] : [{ required: true, message: '请输入口令' }, { min: 6, message: '口令至少 6 位' }]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function RoleModal({
  editing,
  onClose,
  roles,
}: {
  editing?: string;
  onClose: () => void;
  roles: readonly (RoleOption & { description?: string; grants?: string[] })[];
}) {
  const current = roles.find((role) => role.id === editing);
  const [form] = Form.useForm();
  const create = useCreateRole();
  const update = useUpdateRole();
  const text = errorText;
  const isEdit = editing !== undefined;

  return (
    <Modal
      title={isEdit ? `改角色：${current?.name ?? ''}` : '新建角色'}
      open
      okText={isEdit ? '保存' : '建角色'}
      confirmLoading={create.isPending || update.isPending}
      onCancel={onClose}
      onOk={() =>
        void form.validateFields().then((values) => {
          const done = {
            onError: (err: unknown) => void message.error(text(err)),
            onSuccess: () => {
              onClose();
              void message.success(isEdit ? '已保存' : '角色已建好');
            },
          };
          if (isEdit) update.mutate({ id: editing, patch: values }, done);
          else create.mutate(values, done);
        })
      }
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          name: current?.name ?? '',
          description: current?.description ?? '',
          grants: current?.grants ?? ['page:*', 'tool.read:*'],
        }}
      >
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入角色名称' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="description" label="说明">
          <Input.TextArea rows={2} placeholder="这个角色在现场负责什么" />
        </Form.Item>
        <Form.Item
          name="grants"
          label="授权"
          rules={[{ required: true, message: '至少要给一项授权' }]}
          extra="可以直接敲一条新的模式串，* 是通配；单独一条 * = 全部权限"
        >
          <Select mode="tags" options={GRANT_SUGGESTIONS.map((g) => ({ value: g, label: g }))} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function PasswordModal({ onClose }: { onClose: () => void }) {
  const [form] = Form.useForm<{ oldPassword: string; password: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title="改自己的口令"
      open
      okText="改"
      confirmLoading={busy}
      onCancel={onClose}
      onOk={() =>
        void form.validateFields().then(async (values) => {
          setBusy(true);
          setError(null);
          try {
            await changeOwnPassword(values.oldPassword, values.password);
            onClose();
            // 改口令会作废所有会话，界面随即退回登录门
            void message.success('口令已改，请重新登录');
          } catch (err) {
            setError(err instanceof ApiError ? err.message : '改口令失败');
          } finally {
            setBusy(false);
          }
        })
      }
    >
      <Form form={form} layout="vertical">
        <Form.Item name="oldPassword" label="当前口令" rules={[{ required: true, message: '请输入当前口令' }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item
          name="password"
          label="新口令"
          rules={[
            { required: true, message: '请输入新口令' },
            { min: 6, message: '口令至少 6 位' },
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        {error && <Alert type="error" showIcon message={error} />}
      </Form>
    </Modal>
  );
}
