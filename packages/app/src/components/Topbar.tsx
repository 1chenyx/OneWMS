import { Badge, Button, Divider, Layout, Space, Tooltip, Typography } from 'antd';
import { useNodeHello } from '../api/hooks';
import { useAppNav } from '../app-nav';
import { face } from '../theme';

/**
 * 全局顶栏（P1 界面优化）：品牌 + 工作区/节点身份 + 同步状态灯。
 * 状态灯语义是「服务可达性」而非同步业务结果——本地优先架构下，
 * /api/sync/hello 自省可达即正常（绿）、不可达即异常（红）、首连中黄。
 * 无独立同步状态端点，故复用 nodeHello 轮询（15s）做最小实现，不动服务端。
 * 点击状态区跳设置页（节点与同步详情的收口处）。
 */
export default function Topbar() {
  const { navigate } = useAppNav();
  const hello = useNodeHello(15000);

  const status = hello.isPending
    ? { color: 'gold', text: '连接中…' }
    : hello.isError
      ? { color: 'red', text: '连接异常' }
      : { color: 'green', text: '同步正常' };

  const identity = hello.data
    ? `${hello.data.workspaceId} · ${hello.data.nodeId}`
    : hello.isError
      ? '节点不可达'
      : '正在读取节点身份…';

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
      <Tooltip title="打开设置：节点身份与同步详情">
        <Button type="text" size="small" onClick={() => navigate('settings')}>
          <Badge color={status.color} text={status.text} />
        </Button>
      </Tooltip>
    </Layout.Header>
  );
}
