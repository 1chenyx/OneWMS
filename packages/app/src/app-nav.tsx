import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * 应用导航壳（M12 步骤4）：页面 state 切换 + 跳转携带一次性 initialFilter。
 * 左侧大类不单独占一列：悬停大类后浮出功能窗，点具体功能才进页面。
 * 当前页属于哪个大类由 categoryOfPage(page) 推出，rail 据此高亮。
 * AI 聊天的「后置动作」经 navigate 跳到对应管理页（库存操作 → 库存页…），
 * filter 由目标页挂载时消费一次（useState 初始化器里 takeInitialFilter，取后即清）。
 * 提议确认不设独立页：慢通道拍板在 AI 对话页弹窗里完成。
 */

/** 默认落地页：SKU 管理——「无 AI 也能用」是管理界面的主张，AI 是增强不是入口 */
export const DEFAULT_PAGE: Page = 'skus';

export type BuiltinPage =
  | 'dashboard'
  | 'skus'
  | 'partners'
  | 'locations'
  | 'labels'
  | 'inbound'
  | 'qc'
  | 'putaway'
  | 'outbound'
  | 'wave'
  | 'pickings'
  | 'review'
  | 'pack'
  | 'load'
  | 'inventory'
  | 'serials'
  | 'pallets'
  | 'stocktakes'
  | 'expiry'
  | 'chat'
  | 'agents'
  | 'memory'
  | 'ai-config'
  | 'flows'
  | 'rules'
  | 'modules'
  | 'settings';

/**
 * 页面 key（B.6 起开放）。
 *
 * 内置页面保留字面量联合，声明式模块的页面是运行时才知道的字符串
 * （形态 `ui.{moduleId}.{pageId}`，由 GET /api/ui/pages 下发）。
 *
 * ⚠️ 写 `BuiltinPage | (string & {})` 而不是 `BuiltinPage | string`：
 *    后者会被 TS 直接塌成 `string`，27 个内置 key 的编译期检查与自动补全全丢——
 *    写错一个字母（'sku' 而不是 'skus'）从「红线」退化成「运行时白屏」。
 *    `string & {}` 保住字面量成员，同时接纳任意运行时字符串。
 *
 * 代价：索引 PAGE_COMPONENTS 拿不到 undefined 提示（本项目未开
 * noUncheckedIndexedAccess），所以 App.tsx 必须自带兜底渲染，见那里。
 */
export type Page = BuiltinPage | (string & {});

/** navigate 携带给目标页的一次性初始过滤（目标页按需取字段） */
export interface InitialFilter {
  /** 库存/效期页：SKU 编码过滤（AI 查询/调整库存、单 SKU 临期查询后的跳转落点） */
  skuCode?: string;
  /** 单据页：单号过滤（AI 建单后的跳转定位） */
  orderNo?: string;
  /** 托盘页：打开时选中这个托盘 */
  lpnCode?: string;
  /** 拣货页：打开这张已经生成的拣货单 */
  pickingNo?: string;
}

interface AppNavValue {
  page: Page;
  /** 切页；filter 由目标页挂载时消费（一次性） */
  navigate(page: Page, filter?: InitialFilter): void;
  /** 目标页挂载时取走 pending 的 initialFilter（取后即清；无则 undefined） */
  takeInitialFilter(): InitialFilter | undefined;
}

const AppNavContext = createContext<AppNavValue | null>(null);

export function AppNavProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<Page>(DEFAULT_PAGE);
  // ref 而非 state：takeInitialFilter 在目标页 useState 初始化器里同步调用，
  // 必须当场取到 navigate 存入的值（不经 React 渲染周期）
  const pendingFilterRef = useRef<InitialFilter | undefined>(undefined);

  const navigate = useCallback((next: Page, filter?: InitialFilter) => {
    pendingFilterRef.current = filter;
    setPage(next);
  }, []);

  const takeInitialFilter = useCallback(() => {
    const taken = pendingFilterRef.current;
    pendingFilterRef.current = undefined;
    return taken;
  }, []);

  const value = useMemo(
    () => ({ page, navigate, takeInitialFilter }),
    [page, navigate, takeInitialFilter],
  );
  return <AppNavContext.Provider value={value}>{children}</AppNavContext.Provider>;
}

export function useAppNav(): AppNavValue {
  const v = useContext(AppNavContext);
  if (!v) throw new Error('useAppNav 必须在 <AppNavProvider> 内使用');
  return v;
}
