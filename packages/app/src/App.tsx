import type { ComponentType } from 'react';
import { Layout, Menu, Tooltip, theme } from 'antd';
import SkusPage from './pages/SkusPage';
import PartnersPage from './pages/PartnersPage';
import OrdersPage from './pages/OrdersPage';
import PickingsPage from './pages/PickingsPage';
import DashboardPage from './pages/DashboardPage';
import InventoryPage from './pages/InventoryPage';
import StocktakePage from './pages/StocktakePage';
import ExpiryPage from './pages/ExpiryPage';
import ChatPage from './pages/ChatPage';
import AgentsPage from './pages/AgentsPage';
import MemoryPage from './pages/MemoryPage';
import AiConfigPage from './pages/AiConfigPage';
import SettingsPage from './pages/SettingsPage';
import { ChatProvider } from './chat/ChatProvider';
import { AppNavProvider, useAppNav } from './app-nav';
import type { Page } from './app-nav';
import { NAV_CATEGORIES } from './nav';
import Topbar from './components/Topbar';

/**
 * 页面注册表：page key → 组件。新增页面：Page 联合类型加 key →
 * nav.ts 挂到对应大类 → 这里登记组件（替代原来的三元链，功能增多不用改渲染逻辑）。
 */
const PAGE_COMPONENTS: Record<Page, ComponentType> = {
  dashboard: DashboardPage,
  skus: SkusPage,
  partners: PartnersPage,
  orders: OrdersPage,
  pickings: PickingsPage,
  inventory: InventoryPage,
  stocktakes: StocktakePage,
  expiry: ExpiryPage,
  chat: ChatPage,
  agents: AgentsPage,
  memory: MemoryPage,
  'ai-config': AiConfigPage,
  settings: SettingsPage,
};

/**
 * 布局壳（P2 两级导航）：功能增多后单级侧栏会拥挤，改为「大类 rail + 功能面板」——
 * 左侧窄 rail 只放功能大类（看板/作业/档案/智能助手/系统），点大类切右侧二级面板
 * （列出该类功能，不切页），点功能才进页面；跨类跳转（顶栏、AI 后置动作）
 * 由 AppNavProvider 的 navigate 自动联动大类高亮。
 * 分组原则见 nav.ts：看板 = 只读分析视图（运营/效期）；作业 = 高频日常运营；
 * 档案 = 基础主数据（供应商等后续挂这里）；
 * 智能助手 = AI 使用与配置；系统 = 应用设置。默认仍落 SKU 管理——「无 AI 也能用」。
 * 不引路由库：state 切页够用，等页面再多再上 react-router。
 * AppNavProvider 最外层提供 navigate——AI 聊天的后置动作可从任意页面跳到
 * 目标管理页（携带一次性 initialFilter）。
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
  const { page, category, selectCategory, navigate } = useAppNav();
  const { token } = theme.useToken();

  const activeCategory =
    NAV_CATEGORIES.find((c) => c.key === category) ?? NAV_CATEGORIES[0];
  const ActivePage = PAGE_COMPONENTS[page];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {/* 一级导航：功能大类 rail（点大类只切二级面板，不切页） */}
      <nav
        style={{
          flex: '0 0 84px',
          width: 84,
          background: '#fff',
          borderRight: `1px solid ${token.colorBorderSecondary}`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          padding: '12px 8px',
          gap: 4,
        }}
      >
        {NAV_CATEGORIES.map((c) => {
          const Icon = c.icon;
          const active = c.key === category;
          return (
            <Tooltip key={c.key} title={c.description} placement="right">
              <button
                type="button"
                onClick={() => selectCategory(c.key)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '12px 4px',
                  border: 'none',
                  borderRadius: token.borderRadius,
                  background: active ? token.colorPrimaryBg : 'transparent',
                  color: active ? token.colorPrimary : token.colorTextSecondary,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
              >
                <Icon style={{ fontSize: 20 }} />
                <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{c.label}</span>
              </button>
            </Tooltip>
          );
        })}
      </nav>
      {/* 二级导航：当前大类下的功能（点功能进页面） */}
      <Layout.Sider
        theme="light"
        width={168}
        style={{ borderRight: `1px solid ${token.colorBorderSecondary}` }}
      >
        <div style={{ padding: '14px 16px 8px' }}>
          <div style={{ fontSize: 14, fontWeight: 600, lineHeight: '22px' }}>
            {activeCategory.label}
          </div>
          <div style={{ fontSize: 12, color: token.colorTextTertiary }}>
            {activeCategory.description}
          </div>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[page]}
          onClick={({ key }) => navigate(key as Page)}
          style={{ borderInlineEnd: 'none' }}
          items={activeCategory.items.map((item) => ({
            key: item.page,
            icon: <item.icon />,
            label: item.label,
          }))}
        />
      </Layout.Sider>
      <Layout>
        <Topbar />
        <Layout.Content style={{ padding: 16, display: 'flex', flexDirection: 'column' }}>
          {/* ChatProvider 在页面壳级：AI 对话状态跨页存活（切页不丢） */}
          <ChatProvider>
            <ActivePage />
          </ChatProvider>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
