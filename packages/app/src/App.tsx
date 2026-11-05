import {
  AppstoreOutlined,
  AuditOutlined,
  CloudServerOutlined,
  DatabaseOutlined,
  FieldTimeOutlined,
  MessageOutlined,
  ProfileOutlined,
  ReconciliationOutlined,
  RobotOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { Layout, Menu, Typography } from 'antd';
import SkusPage from './pages/SkusPage';
import OrdersPage from './pages/OrdersPage';
import InventoryPage from './pages/InventoryPage';
import StocktakePage from './pages/StocktakePage';
import ExpiryPage from './pages/ExpiryPage';
import ChatPage from './pages/ChatPage';
import AgentsPage from './pages/AgentsPage';
import ProposalsPage from './pages/ProposalsPage';
import AiConfigPage from './pages/AiConfigPage';
import SettingsPage from './pages/SettingsPage';
import { ChatProvider } from './chat/ChatProvider';
import { AppNavProvider, useAppNav } from './app-nav';
import type { Page } from './app-nav';

/**
 * 布局壳：侧导航十页（管理五页 + AI 三页 + AI 模型配置 + 设置）。
 * 默认落在 SKU 管理——「无 AI 也能用」是管理界面的主张，AI 是增强不是入口。
 * AI 区对照（M16/M17）：AI 对话 = 使用（切换助手）、助手管理 = 配置（高权限，
 * 慢通道）、配置确认 = 拍板、AI 模型 = 接入层（模型通道本身，保存即热生效）。
 * 不引路由库：十页 state 切换即可，等页面多了再上 react-router。
 * AppNavProvider（M12 步骤4）最外层提供 navigate——AI 聊天的
 * 后置动作可从任意页面跳到目标管理页（携带一次性 initialFilter）。
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
            { key: 'stocktakes', icon: <ReconciliationOutlined />, label: '盘点' },
            { key: 'expiry', icon: <FieldTimeOutlined />, label: '效期看板' },
            { type: 'divider' },
            { key: 'chat', icon: <MessageOutlined />, label: 'AI 对话' },
            { key: 'agents', icon: <RobotOutlined />, label: '助手管理' },
            { key: 'proposals', icon: <AuditOutlined />, label: '配置确认' },
            { key: 'ai-config', icon: <CloudServerOutlined />, label: 'AI 模型' },
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
          ) : page === 'stocktakes' ? (
            <StocktakePage />
          ) : page === 'expiry' ? (
            <ExpiryPage />
          ) : page === 'chat' ? (
            <ChatPage />
          ) : page === 'agents' ? (
            <AgentsPage />
          ) : page === 'proposals' ? (
            <ProposalsPage />
          ) : page === 'ai-config' ? (
            <AiConfigPage />
          ) : (
            <SettingsPage />
          )}
        </ChatProvider>
      </Layout.Content>
    </Layout>
  );
}
