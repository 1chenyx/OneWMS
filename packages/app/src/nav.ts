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
  DeploymentUnitOutlined,
  AuditOutlined,
  CarOutlined,
  EnvironmentOutlined,
  FieldTimeOutlined,
  PartitionOutlined,
  FileDoneOutlined,
  InboxOutlined,
  MessageOutlined,
  PieChartOutlined,
  ExportOutlined,
  ImportOutlined,
  VerticalAlignTopOutlined,
  ReconciliationOutlined,
  RestOutlined,
  RobotOutlined,
  SettingOutlined,
  SlidersOutlined,
  SwapOutlined,
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
  /** 浮窗内的分组标题：同类功能超过一屏（如「作业」）时按段扫视。不设 = 排在最前的无标题段 */
  group?: string;
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
 * 等往这里挂）；智能助手 = AI 的使用与配置（对话/助手/记忆/模型）；系统 = 流程、规则、模块、
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
      // 作业台是无分组的头名位：以流程待办为入口，先于一切功能清单
      { page: 'workbench', label: '作业台', icon: DeploymentUnitOutlined },
      { page: 'inbound', label: '入库单', icon: ImportOutlined, group: '入库' },
      { page: 'qc', label: '质检', icon: AuditOutlined, moduleId: 'module.qc', group: '入库' },
      { page: 'putaway', label: '上架', icon: VerticalAlignTopOutlined, moduleId: 'module.putaway', group: '入库' },
      { page: 'outbound', label: '出库单', icon: ExportOutlined, group: '出库' },
      { page: 'wave', label: '波次', icon: PartitionOutlined, moduleId: 'module.wave', group: '出库' },
      { page: 'pickings', label: '拣货单', icon: ContainerOutlined, moduleId: 'module.picking', group: '出库' },
      { page: 'review', label: '复核', icon: FileDoneOutlined, moduleId: 'module.review', group: '出库' },
      { page: 'pack', label: '打包', icon: InboxOutlined, moduleId: 'module.pack', group: '出库' },
      { page: 'load', label: '装车', icon: CarOutlined, moduleId: 'module.load', group: '出库' },
      { page: 'inventory', label: '库存', icon: DatabaseOutlined, group: '库存与维护' },
      { page: 'serials', label: '序列号', icon: BarcodeOutlined, moduleId: 'module.serial', group: '库存与维护' },
      { page: 'pallets', label: '托盘', icon: InboxOutlined, moduleId: 'module.lpn', group: '库存与维护' },
      { page: 'stocktakes', label: '盘点', icon: ReconciliationOutlined, group: '库存与维护' },
      { page: 'transfers', label: '调拨单', icon: SwapOutlined, group: '库存与维护' },
      { page: 'scraps', label: '报损单', icon: RestOutlined, group: '库存与维护' },
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
    description: '收发流程、出库与编号规则、仓库能力与应用设置',
    icon: ControlOutlined,
    items: [
      { page: 'flows', label: '流程', icon: ApartmentOutlined },
      { page: 'rules', label: '规则', icon: SlidersOutlined },
      { page: 'modules', label: '模块', icon: ClusterOutlined },
      { page: 'settings', label: '设置', icon: SettingOutlined },
    ],
  },
];

/** 页 → 所属大类（找不到时兜底第一个大类，保证 UI 永远可渲染） */
export function categoryOfPage(page: Page): NavCategory {
  return NAV_CATEGORIES.find((c) => c.items.some((item) => item.page === page)) ?? NAV_CATEGORIES[0];
}

/** 某个大类下登记的内置功能项（不含声明式模块页——那些由 useUiPages 追加） */
export function navItemsOf(key: CategoryKey): readonly NavItem[] {
  return NAV_CATEGORIES.find((c) => c.key === key)?.items ?? [];
}

/** 内置功能的中文名。查不到回 page 本身——宁可显示原始 id，也不要一片空白。 */
export function navLabelOf(page: Page): string {
  for (const category of NAV_CATEGORIES) {
    const found = category.items.find((item) => item.page === page);
    if (found) return found.label;
  }
  return String(page);
}

// ── 声明式模块页面的归类与图标（B.6）────────────────────────
//
// manifest 里的 category / icon 是**自由字符串**：core 是领域无关层，
// 导航大类与图标库都是本包的知识，让它认识 CategoryKey 就是反向依赖。
// 所以映射规则只能长在这里，且必须是「认不出也有得渲染」——
// 模块作者写错一个词，页面顶多位置不对/图标是默认的，不会消失、不会崩。

const CATEGORY_KEYS: readonly CategoryKey[] = NAV_CATEGORIES.map((c) => c.key);

/** 未知大类一律归「档案」：基础主数据是声明式模块最常见的落点 */
export function navCategoryFor(raw?: string): CategoryKey {
  return CATEGORY_KEYS.includes(raw as CategoryKey) ? (raw as CategoryKey) : 'registry';
}

/**
 * 图标白名单。只收本文件已经在用的图标——不是懒得加，而是
 * 「按名字取任意图标」在 Vite 打包后无从实现（没有全量图标表可查），
 * 白名单是唯一能静态打包的做法。
 */
const NAV_ICONS: Record<string, NavIcon> = {
  ApartmentOutlined,
  AppstoreOutlined,
  AuditOutlined,
  BarcodeOutlined,
  BookOutlined,
  BulbOutlined,
  CarOutlined,
  CarryOutOutlined,
  CloudServerOutlined,
  ClusterOutlined,
  ContainerOutlined,
  ControlOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  DeploymentUnitOutlined,
  EnvironmentOutlined,
  ExportOutlined,
  FieldTimeOutlined,
  FileDoneOutlined,
  ImportOutlined,
  InboxOutlined,
  MessageOutlined,
  PartitionOutlined,
  PieChartOutlined,
  ReconciliationOutlined,
  RestOutlined,
  RobotOutlined,
  SettingOutlined,
  SlidersOutlined,
  SwapOutlined,
  TagsOutlined,
  TeamOutlined,
  VerticalAlignTopOutlined,
};

export const DEFAULT_NAV_ICON: NavIcon = AppstoreOutlined;

export function navIconFor(name?: string): NavIcon {
  return (name !== undefined && NAV_ICONS[name]) || DEFAULT_NAV_ICON;
}
