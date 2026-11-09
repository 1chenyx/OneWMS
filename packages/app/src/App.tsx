import type { ComponentType } from 'react';
import { Layout } from 'antd';
import SkusPage from './pages/SkusPage';
import LocationsPage from './pages/LocationsPage';
import PartnersPage from './pages/PartnersPage';
import LabelsPage from './pages/LabelsPage';
import OrdersPage from './pages/OrdersPage';
import PickingsPage from './pages/PickingsPage';
import DashboardPage from './pages/DashboardPage';
import InventoryPage from './pages/InventoryPage';
import SerialsPage from './pages/SerialsPage';
import PalletsPage from './pages/PalletsPage';
import StocktakePage from './pages/StocktakePage';
import ExpiryPage from './pages/ExpiryPage';
import ChatPage from './pages/ChatPage';
import AgentsPage from './pages/AgentsPage';
import MemoryPage from './pages/MemoryPage';
import AiConfigPage from './pages/AiConfigPage';
import FlowsPage from './pages/FlowsPage';
import ModulesPage from './pages/ModulesPage';
import SettingsPage from './pages/SettingsPage';
import { ChatProvider } from './chat/ChatProvider';
import { AppNavProvider, useAppNav } from './app-nav';
import type { Page } from './app-nav';
import ModuleRail from './components/ModuleRail';
import Topbar from './components/Topbar';

/**
 * 页面注册表：page key → 组件。新增页面：Page 联合类型加 key →
 * nav.ts 挂到对应大类 → 这里登记组件（替代原来的三元链，功能增多不用改渲染逻辑）。
 */
const PAGE_COMPONENTS: Record<Page, ComponentType> = {
  dashboard: DashboardPage,
  skus: SkusPage,
  locations: LocationsPage,
  partners: PartnersPage,
  labels: LabelsPage,
  orders: OrdersPage,
  pickings: PickingsPage,
  inventory: InventoryPage,
  serials: SerialsPage,
  pallets: PalletsPage,
  stocktakes: StocktakePage,
  expiry: ExpiryPage,
  chat: ChatPage,
  agents: AgentsPage,
  memory: MemoryPage,
  'ai-config': AiConfigPage,
  flows: FlowsPage,
  modules: ModulesPage,
  settings: SettingsPage,
};

/**
 * 布局壳：左侧窄栏只放功能大类（看板/作业/档案/智能助手/系统）。
 * 点击大类立刻浮出功能块，指针停住稍候也会浮出（网格，不占一列侧栏），点功能才进页面。
 * 当前页所属大类由 page 推出并高亮。
 * 分组原则见 nav.ts：看板 = 只读分析视图（运营/效期）；作业 = 高频日常运营；
 * 档案 = 基础主数据（供应商等后续挂这里）；
 * 智能助手 = AI 使用与配置；系统 = 流程、模块、应用设置。默认仍落 SKU 管理——「无 AI 也能用」。
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
  const { page } = useAppNav();
  const ActivePage = PAGE_COMPONENTS[page];

  return (
    // antd Layout 只有内部有 Sider 时才横向排。左侧是自定义 rail，
    // 不写 row 的话导航会叠在主区上面。
    <Layout style={{ minHeight: '100vh', flexDirection: 'row' }}>
      <ModuleRail />
      <Layout style={{ flex: 1, minWidth: 0 }}>
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
