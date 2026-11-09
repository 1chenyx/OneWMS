import type { ComponentType, CSSProperties } from 'react';
import {
  ApartmentOutlined,
  ClusterOutlined,
  AppstoreOutlined,
  BarcodeOutlined,
  BookOutlined,
  BulbOutlined,
  CarryOutOutlined,
  CloudServerOutlined,
  ContainerOutlined,
  ControlOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  EnvironmentOutlined,
  FieldTimeOutlined,
  InboxOutlined,
  MessageOutlined,
  PieChartOutlined,
  ProfileOutlined,
  ReconciliationOutlined,
  RobotOutlined,
  SettingOutlined,
  TagsOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import type { Page } from './app-nav';

/** 一级导航（大类）key：新增大类时扩展此联合类型并在 NAV_CATEGORIES 登记 */
export type CategoryKey = 'dash' | 'ops' | 'registry' | 'ai' | 'sys';

/** 图标组件类型：antd 图标都接受 style，收窄到这个签名渲染处才能传样式 */
type NavIcon = ComponentType<{ style?: CSSProperties }>;

/** 二级导航项：page 复用 Page 联合类型（key 不改，既有 navigate 调用点零改动） */
export interface NavItem {
  page: Page;
  label: string;
  icon: NavIcon;
  /** 设了就只在该模块 enabled === true 时出现在浮窗里 */
  moduleId?: string;
}

/** 一级导航大类 */
export interface NavCategory {
  key: CategoryKey;
  label: string;
  /** 悬停浮窗的副标题，用来说明分组语义 */
  description: string;
  icon: NavIcon;
  items: NavItem[];
}

/**
 * 两级导航配置（左侧 rail 只放大类，悬停后浮窗列出该类下的功能）。
 * 分组原则：看板 = 只读分析视图（运营/效期，后续报表往这里挂）；作业 = 高频
 * 日常运营（出入库/库存/盘点）；档案 = 基础主数据（SKU，后续供应商/客户/库位
 * 等往这里挂）；智能助手 = AI 的使用与配置（对话/助手/记忆/模型）；系统 = 流程、模块、
 * 应用设置。
 * 新增功能：页面 key 加进 Page 联合类型 → 往对应大类 items 里加一项 →
 * App.tsx 的 PAGE_COMPONENTS 登记组件。
 */
export const NAV_CATEGORIES: readonly NavCategory[] = [
  {
    key: 'dash',
    label: '看板',
    description: '运营分析与效期预警',
    icon: PieChartOutlined,
    items: [
      { page: 'dashboard', label: '运营看板', icon: DashboardOutlined },
      { page: 'expiry', label: '效期看板', icon: FieldTimeOutlined },
    ],
  },
  {
    key: 'ops',
    label: '作业',
    description: '出入库、库存与盘点',
    icon: CarryOutOutlined,
    items: [
      { page: 'orders', label: '出入库单', icon: ProfileOutlined },
      { page: 'pickings', label: '拣货单', icon: ContainerOutlined },
      { page: 'inventory', label: '库存', icon: DatabaseOutlined },
      { page: 'serials', label: '序列号', icon: BarcodeOutlined, moduleId: 'module.serial' },
      { page: 'pallets', label: '托盘', icon: InboxOutlined, moduleId: 'module.lpn' },
      { page: 'stocktakes', label: '盘点', icon: ReconciliationOutlined },
    ],
  },
  {
    key: 'registry',
    label: '档案',
    description: '基础主数据维护',
    icon: BookOutlined,
    items: [
      { page: 'skus', label: 'SKU 管理', icon: AppstoreOutlined },
      { page: 'locations', label: '库位管理', icon: EnvironmentOutlined },
      { page: 'partners', label: '往来单位', icon: TeamOutlined },
      { page: 'labels', label: '条码标签', icon: TagsOutlined },
    ],
  },
  {
    key: 'ai',
    label: '智能助手',
    description: 'AI 对话、助手与模型',
    icon: RobotOutlined,
    items: [
      { page: 'chat', label: 'AI 对话', icon: MessageOutlined },
      { page: 'agents', label: '助手管理', icon: RobotOutlined },
      { page: 'memory', label: 'AI 记忆', icon: BulbOutlined },
      { page: 'ai-config', label: 'AI 模型', icon: CloudServerOutlined },
    ],
  },
  {
    key: 'sys',
    label: '系统',
    description: '收发流程、仓库能力与应用设置',
    icon: ControlOutlined,
    items: [
      { page: 'flows', label: '流程', icon: ApartmentOutlined },
      { page: 'modules', label: '模块', icon: ClusterOutlined },
      { page: 'settings', label: '设置', icon: SettingOutlined },
    ],
  },
];

/** 页 → 所属大类（找不到时兜底第一个大类，保证 UI 永远可渲染） */
export function categoryOfPage(page: Page): NavCategory {
  return NAV_CATEGORIES.find((c) => c.items.some((item) => item.page === page)) ?? NAV_CATEGORIES[0];
}
