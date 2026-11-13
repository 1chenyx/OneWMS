import type { ComponentType } from 'react';
import { Layout } from 'antd';
import './app.css';
import SkusPage from './pages/SkusPage';
import LocationsPage from './pages/LocationsPage';
import PartnersPage from './pages/PartnersPage';
import LabelsPage from './pages/LabelsPage';
import { InboundOrdersPage, OutboundOrdersPage } from './pages/OrdersPage';
import PutawayPage from './pages/PutawayPage';
import { LoadPage, PackPage, QcPage, ReviewPage } from './pages/StagePage';
import WavePage from './pages/WavePage';
import PickingsPage from './pages/PickingsPage';
import DashboardPage from './pages/DashboardPage';
import ReportsPage from './pages/ReportsPage';
import WorkbenchPage from './pages/WorkbenchPage';
import InventoryPage from './pages/InventoryPage';
import SerialsPage from './pages/SerialsPage';
import PalletsPage from './pages/PalletsPage';
import StocktakePage from './pages/StocktakePage';
import TransfersPage from './pages/TransfersPage';
import ScrapsPage from './pages/ScrapsPage';
import ExpiryPage from './pages/ExpiryPage';
import ChatPage from './pages/ChatPage';
import AgentsPage from './pages/AgentsPage';
import MemoryPage from './pages/MemoryPage';
import AiConfigPage from './pages/AiConfigPage';
import FlowsPage from './pages/FlowsPage';
import RulesPage from './pages/RulesPage';
import ModulesPage from './pages/ModulesPage';
import IntegrationsPage from './pages/IntegrationsPage';
import SettingsPage from './pages/SettingsPage';
import DynamicPage from './pages/DynamicPage';
import { ChatProvider } from './chat/ChatProvider';
import { AppNavProvider, useAppNav } from './app-nav';
import type { BuiltinPage, Page } from './app-nav';
import ModuleRail from './components/ModuleRail';
import CommandPalette from './components/CommandPalette';
import Topbar from './components/Topbar';
import ChatDock from './components/ChatDock';

/**
 * 页面注册表：内置 page key → 组件。新增内置页面：BuiltinPage 加 key →
 * nav.ts 挂到对应大类 → 这里登记组件。
 *
 * 类型收在 BuiltinPage 而不是开放后的 Page：漏登记一个内置页面会当场编译报错。
 * Page 自 B.6 起接纳运行时字符串（声明式模块的页面），这份穷尽性检查是
 * 开放之后唯一还留着的安全网，别顺手改成 Record<Page, …>——那样它就查不出任何东西了。
 */
const PAGE_COMPONENTS: Record<BuiltinPage, ComponentType> = {
  dashboard: DashboardPage,
  reports: ReportsPage,
  workbench: WorkbenchPage,
  skus: SkusPage,
  locations: LocationsPage,
  partners: PartnersPage,
  labels: LabelsPage,
  inbound: InboundOrdersPage,
  qc: QcPage,
  putaway: PutawayPage,
  outbound: OutboundOrdersPage,
  wave: WavePage,
  pickings: PickingsPage,
  review: ReviewPage,
  pack: PackPage,
  load: LoadPage,
  inventory: InventoryPage,
  serials: SerialsPage,
  pallets: PalletsPage,
  stocktakes: StocktakePage,
  transfers: TransfersPage,
  scraps: ScrapsPage,
  expiry: ExpiryPage,
  chat: ChatPage,
  agents: AgentsPage,
  memory: MemoryPage,
  'ai-config': AiConfigPage,
  flows: FlowsPage,
  rules: RulesPage,
  modules: ModulesPage,
  integrations: IntegrationsPage,
  settings: SettingsPage,
};

/**
 * 布局壳：左侧窄栏只放功能大类（看板/作业/档案/智能助手/系统）。
 * 点击大类立刻浮出功能块，指针停住稍候也会浮出（网格，不占一列侧栏），点功能才进页面。
 * 当前页所属大类由 page 推出并高亮。
 * 分组原则见 nav.ts：看板 = 只读分析视图（运营/效期）；作业 = 高频日常运营；
 * 档案 = 基础主数据（供应商等后续挂这里）；
 * 智能助手 = AI 使用与配置；系统 = 流程、规则、模块、对接、应用设置。默认仍落 SKU 管理——「无 AI 也能用」。
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
  // 查不到 = 不是内置页面，交给 DynamicPage 按 /api/ui/pages 的描述渲染（B.6）。
  // ⚠️ 这个 ?? 不能省：本项目未开 noUncheckedIndexedAccess，索引不到不会报错，
  //    会直接渲染 <undefined /> 把整个主区炸成白屏。
  const ActivePage = (PAGE_COMPONENTS as Partial<Record<Page, ComponentType>>)[page] ?? DynamicPage;

  return (
    // antd Layout 只有内部有 Sider 时才横向排。左侧是自定义 rail，
    // 不写 row 的话导航会叠在主区上面。
    // 高度锁在视口里：列表、详情、对话都在主区里滚，不能把整个窗口撑开。
    <Layout className="app-shell" style={{ height: '100%', overflow: 'hidden', flexDirection: 'row' }}>
      <ModuleRail />
      {/* Ctrl+K 全局搜索：功能再多也有直达入口，挂在壳级与页面无关 */}
      <CommandPalette />
      <Layout style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        <Topbar />
        <Layout.Content
          className="app-content"
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
            padding: 24,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* ChatProvider 在页面壳级：AI 对话状态跨页存活（切页不丢）。浮窗和整页共用这一份。 */}
          <ChatProvider>
            <div className="app-page" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <ActivePage />
            </div>
            <ChatDock />
          </ChatProvider>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
