import { useMemo, useState } from 'react';
import { Popover } from 'antd';
import { ease, face } from '../theme';
import { useProfileSnapshot, useUiPages } from '../api/hooks';
import type { UiPageDescriptor } from '../api/client';
import { useAppNav } from '../app-nav';
import type { Page } from '../app-nav';
import { NAV_CATEGORIES, categoryOfPage, navCategoryFor, navIconFor } from '../nav';
import type { CategoryKey, NavCategory, NavItem } from '../nav';

/** 划过大类时稍等再打开，避免鼠标掠过就闪出浮窗 */
const FLYOUT_OPEN_DELAY_S = 0.4;
/** 离开大类或浮窗前的短暂停留，方便指针移进浮窗 */
const FLYOUT_CLOSE_DELAY_S = 0.2;

/**
 * 左侧功能大类。不占二级侧栏：点击大类立刻浮出功能块；指针停住约 0.4 秒也会浮出。
 * 浮窗里是该类功能的网格，不是竖列菜单。点功能块才进入页面。
 * 当前页所属大类保持高亮，由 page 推出，不另记「正在浏览的大类」。
 */
export default function ModuleRail() {
  const { page, navigate } = useAppNav();
  const snapshot = useProfileSnapshot();
  const uiPages = useUiPages();
  const [openKey, setOpenKey] = useState<CategoryKey | null>(null);
  const [hotKey, setHotKey] = useState<CategoryKey | null>(null);
  const descriptors = uiPages.data?.pages;
  const dynamic = useMemo(() => dynamicItemsByCategory(descriptors), [descriptors]);
  // 动态页面不在 NAV_CATEGORIES 里，categoryOfPage 只会兜底到第一个大类（看板），
  // 高亮就错了——所以先问页面清单，问不到再走内置那套（兜底逻辑原样保留）
  const current = descriptors?.find((item) => item.id === page);
  const activeKey = current ? navCategoryFor(current.category) : categoryOfPage(page).key;

  const pick = (next: Page) => {
    navigate(next);
    setOpenKey(null);
  };

  return (
    <nav
      style={{
        flex: '0 0 84px',
        width: 84,
        minHeight: 0,
        overflowY: 'auto',
        background: face.card,
        borderRight: `1px solid ${face.line}`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        padding: '16px 8px',
        gap: 4,
      }}
    >
      {NAV_CATEGORIES.map((category) => {
        const Icon = category.icon;
        const open = openKey === category.key;
        const lit = category.key === activeKey || open || hotKey === category.key;
        return (
          <Popover
            key={category.key}
            trigger={['hover', 'click']}
            placement="rightTop"
            arrow={false}
            mouseEnterDelay={FLYOUT_OPEN_DELAY_S}
            mouseLeaveDelay={FLYOUT_CLOSE_DELAY_S}
            destroyOnHidden
            open={open}
            align={{ offset: [8, 0] }}
            styles={{ body: { padding: 12 } }}
            onOpenChange={(next) => {
              setOpenKey((cur) => {
                if (next) return category.key;
                return cur === category.key ? null : cur;
              });
            }}
            content={
              <ModuleFlyout
                category={category}
                items={visibleNavItems(category, snapshot.data?.modules).concat(dynamic[category.key])}
                page={page}
                onPick={pick}
              />
            }
          >
            <button
              type="button"
              aria-label={category.label}
              aria-haspopup="dialog"
              aria-expanded={open}
              onMouseEnter={() => setHotKey(category.key)}
              onMouseLeave={() => setHotKey((cur) => (cur === category.key ? null : cur))}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
                width: '100%',
                padding: '8px 4px',
                border: 'none',
                borderRadius: 8,
                background: lit ? face.raised : 'transparent',
                color: lit ? face.ink : face.text2,
                boxShadow: lit ? `inset 3px 0 0 ${face.amber}` : 'none',
                font: 'inherit',
                cursor: 'pointer',
                userSelect: 'none',
                transition: `background-color 160ms ${ease}, color 160ms ${ease}, box-shadow 160ms ${ease}`,
              }}
            >
              <Icon style={{ fontSize: 16 }} />
              <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{category.label}</span>
            </button>
          </Popover>
        );
      })}
    </nav>
  );
}

/** 浮窗里的具体功能：两列格子（只有一个功能时单格），点一下进入页面 */
function visibleNavItems<T extends { enabled?: boolean }>(
  category: NavCategory,
  modules: Record<string, T> | undefined,
): NavItem[] {
  return category.items.filter((item) => item.moduleId == null || modules?.[item.moduleId]?.enabled === true);
}

/**
 * 声明式模块的页面 → 按大类分桶的导航项（B.6）。
 *
 * 不设 NavItem.moduleId：那字段是「内置项按模块开关显隐」的过滤条件，
 * 而动态页面已经由服务端按「已安装且 enabled」过滤过一遍（GET /api/ui/pages），
 * 再挂上 moduleId 只会被 visibleNavItems 二次过滤，两份真相迟早对不上。
 */
function dynamicItemsByCategory(
  pages: readonly UiPageDescriptor[] | undefined,
): Record<CategoryKey, NavItem[]> {
  const buckets = Object.fromEntries(NAV_CATEGORIES.map((c) => [c.key, [] as NavItem[]])) as Record<
    CategoryKey,
    NavItem[]
  >;
  for (const item of pages ?? []) {
    buckets[navCategoryFor(item.category)].push({
      page: item.id,
      label: item.label,
      icon: navIconFor(item.icon),
    });
  }
  return buckets;
}

/**
 * 浮窗网格里的「槽位」：分组标题或功能块。
 * 分组来自 NavItem.group（声明式模块页没有这个字段，与内置项混排时不加标题）。
 */
type FlyoutSlot = { header: string } | { item: NavItem };

/**
 * 功能清单 → 分段网格：无分组项排最前，之后按首次出现顺序输出各分组标题。
 * 只有一个分组时不输出标题（两三个功能再分段反而碎）。
 */
function groupFlyoutItems(items: readonly NavItem[]): FlyoutSlot[] {
  const groups = new Set(items.map((item) => item.group).filter((g): g is string => g !== undefined));
  const titled = groups.size > 1;
  const slots: FlyoutSlot[] = [];
  const emitted = new Set<string>();
  for (const item of items) {
    if (titled && item.group !== undefined && !emitted.has(item.group)) {
      emitted.add(item.group);
      slots.push({ header: item.group });
    }
    slots.push({ item });
  }
  return slots;
}

function ModuleFlyout({
  category,
  items,
  page,
  onPick,
}: {
  category: NavCategory;
  items: NavItem[];
  page: Page;
  onPick: (page: Page) => void;
}) {
  const multi = items.length > 1;

  return (
    <div role="dialog" aria-label={`${category.label}功能`} style={{ width: multi ? 280 : 148 }}>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 500, lineHeight: '20px' }}>{category.label}</div>
        <div style={{ fontSize: 12, color: face.text3 }}>{category.description}</div>
      </div>
      <div
        data-testid="module-flyout-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: multi ? '1fr 1fr' : '1fr',
          gap: 8,
          // 功能块会随模块装卸继续变多（作业已有十余个）。不封顶就是硬裁切：
          // Popover 超出视口的部分既看不见也滚不到，排在末尾的入口等于不存在。
          maxHeight: 'calc(100vh - 150px)',
          overflowY: 'auto',
        }}
      >
        {groupFlyoutItems(items).map((slot) =>
          'header' in slot ? (
            <div
              key={`header:${slot.header}`}
              style={{ gridColumn: '1 / -1', fontSize: 12, color: face.text3, marginTop: 4 }}
            >
              {slot.header}
            </div>
          ) : (
            <ModuleTile key={slot.item.page} item={slot.item} active={slot.item.page === page} onPick={onPick} />
          ),
        )}
      </div>
    </div>
  );
}

function ModuleTile({
  item,
  active,
  onPick,
}: {
  item: NavItem;
  active: boolean;
  onPick: (page: Page) => void;
}) {
  const [hot, setHot] = useState(false);
  const Icon = item.icon;

  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={() => onPick(item.page)}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        minHeight: 72,
        padding: '12px 8px',
        border: `1px solid ${face.line}`,
        borderRadius: 8,
        background: active || hot ? face.raised : face.card,
        color: face.ink,
        boxShadow: active ? `inset 3px 0 0 ${face.amber}` : 'none',
        cursor: 'pointer',
        font: 'inherit',
        transition: `background-color 160ms ${ease}, box-shadow 160ms ${ease}`,
      }}
    >
      <Icon style={{ fontSize: 16, color: face.text2 }} />
      <span style={{ fontSize: 12, lineHeight: '16px', whiteSpace: 'nowrap' }}>{item.label}</span>
    </button>
  );
}
