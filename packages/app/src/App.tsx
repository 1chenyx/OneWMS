import { useState } from 'react';
import {
  AppstoreOutlined,
  AuditOutlined,
  DatabaseOutlined,
  MessageOutlined,
  ProfileOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { Layout, Menu, Typography } from 'antd';
import SkusPage from './pages/SkusPage';
import OrdersPage from './pages/OrdersPage';
import InventoryPage from './pages/InventoryPage';
import ChatPage from './pages/ChatPage';
import ProposalsPage from './pages/ProposalsPage';
import SettingsPage from './pages/SettingsPage';

/**
 * 布局壳：侧导航六页（管理三页 + AI 两页 + 设置）。
 * 默认落在 SKU 管理——「无 AI 也能用」是管理界面的主张，AI 是增强不是入口。
 * 不引路由库：六页 state 切换即可，等页面多了再上 react-router。
 */
type Page = 'skus' | 'orders' | 'inventory' | 'chat' | 'proposals' | 'settings';

export default function App() {
  const [page, setPage] = useState<Page>('skus');

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider theme="light" width={200}>
        <Typography.Title level={4} style={{ padding: '16px 16px 8px' }}>
          OneWMS
        </Typography.Title>
        <Menu
          mode="inline"
          selectedKeys={[page]}
          onClick={({ key }) => setPage(key as Page)}
          items={[
            { key: 'skus', icon: <AppstoreOutlined />, label: 'SKU 管理' },
            { key: 'orders', icon: <ProfileOutlined />, label: '出入库单' },
            { key: 'inventory', icon: <DatabaseOutlined />, label: '库存' },
            { type: 'divider' },
            { key: 'chat', icon: <MessageOutlined />, label: 'AI 对话' },
            { key: 'proposals', icon: <AuditOutlined />, label: '配置确认' },
            { key: 'settings', icon: <SettingOutlined />, label: '设置' },
          ]}
        />
      </Layout.Sider>
      <Layout.Content style={{ padding: 16, display: 'flex', flexDirection: 'column' }}>
        {page === 'skus' ? (
          <SkusPage />
        ) : page === 'orders' ? (
          <OrdersPage />
        ) : page === 'inventory' ? (
          <InventoryPage />
        ) : page === 'chat' ? (
          <ChatPage />
        ) : page === 'proposals' ? (
          <ProposalsPage />
        ) : (
          <SettingsPage />
        )}
      </Layout.Content>
    </Layout>
  );
}
