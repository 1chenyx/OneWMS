import { useState } from 'react';
import { Popover, theme } from 'antd';
import { useAppNav } from '../app-nav';
import type { Page } from '../app-nav';
import { NAV_CATEGORIES, categoryOfPage } from '../nav';
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
  const { token } = theme.useToken();
  const [openKey, setOpenKey] = useState<CategoryKey | null>(null);
  const [hotKey, setHotKey] = useState<CategoryKey | null>(null);
  const activeKey = categoryOfPage(page).key;

  const pick = (next: Page) => {
    navigate(next);
    setOpenKey(null);
  };

  return (
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
            content={<ModuleFlyout category={category} page={page} onPick={pick} />}
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
                gap: 6,
                width: '100%',
                padding: '12px 4px',
                border: 'none',
                borderRadius: token.borderRadius,
                background: lit ? token.colorPrimaryBg : 'transparent',
                color: lit ? token.colorPrimary : token.colorTextSecondary,
                font: 'inherit',
                cursor: 'pointer',
                userSelect: 'none',
                transition: 'all 0.2s',
              }}
            >
              <Icon style={{ fontSize: 20 }} />
              <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{category.label}</span>
            </button>
          </Popover>
        );
      })}
    </nav>
  );
}

/** 浮窗里的具体功能：两列格子（只有一个功能时单格），点一下进入页面 */
function ModuleFlyout({
  category,
  page,
  onPick,
}: {
  category: NavCategory;
  page: Page;
  onPick: (page: Page) => void;
}) {
  const { token } = theme.useToken();
  const multi = category.items.length > 1;

  return (
    <div role="dialog" aria-label={`${category.label}功能`} style={{ width: multi ? 280 : 148 }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600, lineHeight: '22px' }}>{category.label}</div>
        <div style={{ fontSize: 12, color: token.colorTextTertiary }}>{category.description}</div>
      </div>
      <div
        data-testid="module-flyout-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: multi ? '1fr 1fr' : '1fr',
          gap: 8,
        }}
      >
        {category.items.map((item) => (
          <ModuleTile key={item.page} item={item} active={item.page === page} onPick={onPick} />
        ))}
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
  const { token } = theme.useToken();
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
        gap: 6,
        minHeight: 72,
        padding: '10px 8px',
        border: `1px solid ${active ? token.colorPrimaryBorder : token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        background: active
          ? token.colorPrimaryBg
          : hot
            ? token.colorFillTertiary
            : token.colorBgContainer,
        color: active ? token.colorPrimary : token.colorText,
        cursor: 'pointer',
        transition: 'all 0.2s',
      }}
    >
      <Icon style={{ fontSize: 20 }} />
      <span style={{ fontSize: 12, lineHeight: '16px', whiteSpace: 'nowrap' }}>{item.label}</span>
    </button>
  );
}
