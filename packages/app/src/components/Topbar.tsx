import { Badge, Button, Divider, Layout, Space, Tooltip, Typography } from 'antd';
import { useConnection, useNodeHello, usePlatformMe, usePlatformToken } from '../api/hooks';
import { useAppNav } from '../app-nav';
import { roleLabel } from '../lib/connection';
import { face } from '../theme';

/**
 * 顶栏标明现在连的是平台还是局域网。
 * 局域网：本机 /api/sync/hello 通就是绿。平台：有登录身份就是绿，没登录是黄。
 * 点状态进设置，在那里切换。
 */
export default function Topbar() {
  const { navigate } = useAppNav();
  const connection = useConnection();
  const platform = connection.data?.mode === 'platform';
  const hello = useNodeHello(15000, !connection.isLoading && !platform);
  const token = usePlatformToken();
  const me = usePlatformMe();

  const status = platform
    ? !token
      ? { color: 'gold', text: '平台 · 未登录' }
      : me.isPending
        ? { color: 'gold', text: '平台 · 连接中' }
        : me.isError
          ? { color: 'red', text: '平台 · 连接异常' }
          : { color: 'green', text: '平台' }
    : connection.isLoading
      ? { color: 'gold', text: '连接中…' }
      : hello.isPending
        ? { color: 'gold', text: '局域网 · 连接中' }
        : hello.isError
          ? { color: 'red', text: '局域网 · 连接异常' }
          : { color: 'green', text: '局域网' };

  const identity = platform
    ? me.data
      ? `${me.data.workspace?.name ?? '未选工作区'} · ${me.data.user.email}${
          me.data.workspace ? ` · ${roleLabel(me.data.workspace.role)}` : ''
        }`
      : token
        ? '正在读取平台身份…'
        : '平台 · 未登录'
    : hello.data
      ? `${hello.data.workspaceId} · ${hello.data.nodeId}`
      : hello.isError
        ? '本机节点不可达'
        : '正在读取本机节点…';

  const tip = platform
    ? '当前连的是平台。打开设置可改回局域网'
    : '当前连的是局域网。打开设置可改为平台';

  return (
    <Layout.Header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        height: 56,
        lineHeight: 'normal',
        paddingInline: 24,
        background: face.card,
        borderBottom: `1px solid ${face.line}`,
      }}
    >
      <Space size={12} align="center" style={{ minWidth: 0 }}>
        <Typography.Text style={{ fontSize: 16, fontWeight: 500, whiteSpace: 'nowrap' }}>
          OneWMS
        </Typography.Text>
        <Divider type="vertical" style={{ marginInline: 0, borderColor: face.lineStrong }} />
        <Typography.Text ellipsis style={{ maxWidth: 420, fontFamily: face.mono, fontSize: 13, color: face.text2 }}>
          {identity}
        </Typography.Text>
      </Space>
      <Tooltip title={tip}>
        <Button type="text" size="small" onClick={() => navigate('settings')}>
          <Badge color={status.color} text={status.text} />
        </Button>
      </Tooltip>
    </Layout.Header>
  );
}
