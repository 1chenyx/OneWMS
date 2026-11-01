import {
  AppstoreOutlined,
  AuditOutlined,
  DatabaseOutlined,
  FieldTimeOutlined,
  MessageOutlined,
  ProfileOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { Layout, Menu, Typography } from 'antd';
import SkusPage from './pages/SkusPage';
import OrdersPage from './pages/OrdersPage';
import InventoryPage from './pages/InventoryPage';
import ExpiryPage from './pages/ExpiryPage';
import ChatPage from './pages/ChatPage';
import ProposalsPage from './pages/ProposalsPage';
import SettingsPage from './pages/SettingsPage';
import { ChatProvider } from './chat/ChatProvider';
import { AppNavProvider, useAppNav } from './app-nav';
import type { Page } from './app-nav';

/**
 * 布局壳：侧导航七页（管理四页 + AI 两页 + 设置）。
 * 默认落在 SKU 管理——「无 AI 也能用」是管理界面的主张，AI 是增强不是入口。
 * 不引路由库：七页 state 切换即可，等页面多了再上 react-router。
 * AppNavProvider（M12 步骤4）最外层提供 navigate——AI 聊天的后置动作
 * 可从任意页面跳到目标管理页（携带一次性 initialFilter）。
 */
export default function App() {
  return (
    <AppNavProvider>
      <AppShell />
    </AppNavProvider>
  );
}

/** 页面壳（AppNavProvider 内）：导航状态经 useAppNav 消费 */
function AppShell() {
  const { page, navigate } = useAppNav();

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider theme="light" width={200}>
        <Typography.Title level={4} style={{ padding: '16px 16px 8px' }}>
          OneWMS
        </Typography.Title>
        <Menu
          mode="inline"
          selectedKeys={[page]}
          onClick={({ key }) => navigate(key as Page)}
          items={[
            { key: 'skus', icon: <AppstoreOutlined />, label: 'SKU 管理' },
            { key: 'orders', icon: <ProfileOutlined />, label: '出入库单' },
            { key: 'inventory', icon: <DatabaseOutlined />, label: '库存' },
            { key: 'expiry', icon: <FieldTimeOutlined />, label: '效期看板' },
            { type: 'divider' },
            { key: 'chat', icon: <MessageOutlined />, label: 'AI 对话' },
            { key: 'proposals', icon: <AuditOutlined />, label: '配置确认' },
            { key: 'settings', icon: <SettingOutlined />, label: '设置' },
          ]}
        />
      </Layout.Sider>
      <Layout.Content style={{ padding: 16, display: 'flex', flexDirection: 'column' }}>
        {/* ChatProvider 在页面壳级：AI 对话状态跨页存活（切页不丢） */}
        <ChatProvider>
          {page === 'skus' ? (
            <SkusPage />
          ) : page === 'orders' ? (
            <OrdersPage />
          ) : page === 'inventory' ? (
            <InventoryPage />
          ) : page === 'expiry' ? (
            <ExpiryPage />
          ) : page === 'chat' ? (
            <ChatPage />
          ) : page === 'proposals' ? (
            <ProposalsPage />
          ) : (
            <SettingsPage />
          )}
        </ChatProvider>
      </Layout.Content>
    </Layout>
  );
}
