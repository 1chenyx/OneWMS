import { useCallback, useState } from 'react';
import { BoardWork } from '../board/BoardWork.js';
import { StockLookup } from '../board/StockLookup.js';
import { FloorWork } from '../receive/FloorWork.js';
import { screenOpen } from '../screens.js';
import { useFieldSession } from '../session.js';
import { SettingsPage } from './SettingsPage.js';

type FloorTab = 'tasks' | 'drafts' | 'settings';
type ManageTab = 'board' | 'stock' | 'settings';

export function Shell() {
  const session = useFieldSession();
  const mode = session.store.prefs.mode;
  const [floorTab, setFloorTab] = useState<FloorTab>('tasks');
  const [manageTab, setManageTab] = useState<ManageTab>('board');
  const [inJob, setInJob] = useState(false);
  const [manageDrill, setManageDrill] = useState(false);
  const onJob = useCallback((open: boolean) => setInJob(open), []);
  const onDrill = useCallback((open: boolean) => setManageDrill(open), []);
  const tab = mode === 'floor' ? floorTab : manageTab;
  const job = mode === 'floor' && floorTab !== 'settings' && inJob;
  const quiet = job || (mode === 'manage' && manageDrill);
  const boardOn = screenOpen('manageBoard');

  const title = mode === 'floor' ? (tab === 'drafts' ? '进行中' : tab === 'settings' ? '设置' : '任务') : tab === 'stock' ? '库存' : tab === 'settings' ? '设置' : '看板';

  return (
    <div className="field-screen">
      {quiet ? null : (
        <header className="field-bar">
          <h1 className="field-title">{title}</h1>
        </header>
      )}
      <div className="field-scroll">
        {tab === 'settings' ? (
          <SettingsPage />
        ) : (
          <main className="field-main">
            {mode === 'floor' && floorTab !== 'settings' ? (
              <FloorWork tab={floorTab} onJob={onJob} onTab={(next) => setFloorTab(next)} />
            ) : null}
            {mode === 'manage' && tab === 'board' ? (
              boardOn ? <BoardWork onDrill={onDrill} /> : <p className="field-empty">看板上还没有数字</p>
            ) : null}
            {mode === 'manage' && tab === 'stock' ? <StockLookup /> : null}
          </main>
        )}
      </div>
      <nav className="field-nav" aria-label={mode === 'floor' ? '现场' : '管理'}>
        {mode === 'floor' ? (
          <>
            <NavButton current={floorTab === 'tasks'} icon="tasks" onClick={() => setFloorTab('tasks')}>
              任务
            </NavButton>
            <NavButton current={floorTab === 'drafts'} icon="drafts" onClick={() => setFloorTab('drafts')}>
              进行中
            </NavButton>
            <NavButton current={floorTab === 'settings'} icon="settings" onClick={() => setFloorTab('settings')}>
              设置
            </NavButton>
          </>
        ) : (
          <>
            <NavButton current={manageTab === 'board'} icon="board" onClick={() => { setManageDrill(false); setManageTab('board'); }}>
              看板
            </NavButton>
            {boardOn ? (
              <NavButton current={manageTab === 'stock'} icon="stock" onClick={() => { setManageDrill(false); setManageTab('stock'); }}>
                库存
              </NavButton>
            ) : null}
            <NavButton current={manageTab === 'settings'} icon="settings" onClick={() => { setManageDrill(false); setManageTab('settings'); }}>
              设置
            </NavButton>
          </>
        )}
      </nav>
    </div>
  );
}

function NavButton({
  current,
  onClick,
  icon,
  children,
}: {
  current: boolean;
  onClick: () => void;
  icon: 'tasks' | 'drafts' | 'board' | 'stock' | 'settings';
  children: string;
}) {
  return (
    <button type="button" className={current ? 'is-current' : undefined} aria-current={current ? 'page' : undefined} onClick={onClick}>
      <NavIcon name={icon} />
      <span>{children}</span>
    </button>
  );
}

function NavIcon({ name }: { name: 'tasks' | 'drafts' | 'board' | 'stock' | 'settings' }) {
  const common = { viewBox: '0 0 24 24', 'aria-hidden': true as const, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (name === 'tasks') {
    return (
      <svg {...common}>
        <path d="M9 6h11M9 12h11M9 18h11" />
        <path d="M4 6h.01M4 12h.01M4 18h.01" />
      </svg>
    );
  }
  if (name === 'drafts') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v5l3 2" />
      </svg>
    );
  }
  if (name === 'board') {
    return (
      <svg {...common}>
        <rect x="4" y="4" width="7" height="7" rx="1.5" />
        <rect x="13" y="4" width="7" height="7" rx="1.5" />
        <rect x="4" y="13" width="7" height="7" rx="1.5" />
        <rect x="13" y="13" width="7" height="7" rx="1.5" />
      </svg>
    );
  }
  if (name === 'stock') {
    return (
      <svg {...common}>
        <path d="M4 8l8-4 8 4-8 4-8-4z" />
        <path d="M4 12l8 4 8-4" />
        <path d="M4 16l8 4 8-4" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
    </svg>
  );
}
