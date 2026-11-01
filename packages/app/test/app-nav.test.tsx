import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { AppNavProvider, useAppNav } from '../src/app-nav';
import type { InitialFilter } from '../src/app-nav';

/**
 * 导航壳单测（M12 步骤4）：navigate 切页 + initialFilter 一次性消费语义。
 * （页面接参的端到端在 manage.test.tsx：navigate → 页面挂载 → 过滤框预填）
 */

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

/** 驱动组件：展示当前页；点击按钮 navigate；take 结果 JSON 直出（undefined → 'null'） */
function Probe({ filter }: { filter?: InitialFilter }) {
  const { page, navigate, takeInitialFilter } = useAppNav();
  const [taken, setTaken] = useState('(未取)');
  return (
    <div>
      <span data-testid="page">{page}</span>
      <button onClick={() => navigate('inventory', filter)}>跳库存页</button>
      <button onClick={() => setTaken(JSON.stringify(takeInitialFilter()) ?? 'undefined')}>取</button>
      <span data-testid="taken">{taken}</span>
    </div>
  );
}

const wrap = (ui: React.ReactNode) => <AppNavProvider>{ui}</AppNavProvider>;

describe('AppNavProvider：navigate 与一次性 initialFilter', () => {
  it('默认页 skus；navigate 切页', async () => {
    const user = userEvent.setup();
    render(wrap(<Probe filter={{ skuCode: 'A-1' }} />));
    expect(screen.getByTestId('page').textContent).toBe('skus');

    await user.click(screen.getByRole('button', { name: '跳库存页' }));
    expect(screen.getByTestId('page').textContent).toBe('inventory');
  });

  it('navigate 携带的 filter 在 take 后清空（一次性）', async () => {
    const user = userEvent.setup();
    render(wrap(<Probe filter={{ skuCode: 'A-1' }} />));

    await user.click(screen.getByRole('button', { name: '跳库存页' }));
    await user.click(screen.getByRole('button', { name: '取' }));
    expect(screen.getByTestId('taken').textContent).toBe('{"skuCode":"A-1"}');

    await user.click(screen.getByRole('button', { name: '取' })); // 第二次取 → 空
    expect(screen.getByTestId('taken').textContent).toBe('undefined');
  });

  it('无 filter 的 navigate → take 得 undefined', async () => {
    const user = userEvent.setup();
    render(wrap(<Probe />));

    await user.click(screen.getByRole('button', { name: '跳库存页' }));
    await user.click(screen.getByRole('button', { name: '取' }));
    expect(screen.getByTestId('taken').textContent).toBe('undefined');
  });
});
