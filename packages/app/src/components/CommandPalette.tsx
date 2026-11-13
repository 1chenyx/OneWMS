import { useEffect, useMemo, useRef, useState } from 'react';
import { Input, Modal } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useProfileSnapshot, useUiPages } from '../api/hooks';
import { useAppNav } from '../app-nav';
import type { Page } from '../app-nav';
import { NAV_CATEGORIES, navIconFor } from '../nav';
import { face } from '../theme';

/**
 * Ctrl+K 全局搜索（命令面板）：所有页面入口的唯一可扩展查找方式。
 *
 * 浮窗分组解决「扫视」，这里解决「直达」——功能再多也不用记它在哪个大类哪一组：
 * 敲两三个字，回车进页面。候选 = 内置导航项（按模块开关过滤，规则与浮窗一致）
 * + 声明式模块页（服务端已按启用状态过滤，不再二次判断）。
 *
 * 匹配只做大小写不敏感的子串（label / page id / 分组名 / 大类名），
 * 不引拼音与模糊搜索库——候选总量是个页面数的量级，子串够用，
 * 真不够了再换 fuse.js 之类的纯逻辑库。
 */

const MAX_RESULTS = 9;

interface Candidate {
  page: Page;
  label: string;
  /** 展示用归属：分组名或大类名，帮用户确认「就是它」 */
  hint: string;
  icon: ReturnType<typeof navIconFor>;
}

export default function CommandPalette() {
  const { page, navigate } = useAppNav();
  const snapshot = useProfileSnapshot();
  const uiPages = useUiPages();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 全局快捷键：Ctrl+K（Windows）/ Cmd+K（Mac）。挂在 window 上，
  // 不依赖焦点在哪个输入框之外的区域——但别拦输入框里的默认行为。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 每次打开都回到干净状态；焦点进输入框（antd Modal autoFocus 与手动 focus 二选一，手动更稳）
  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const candidates = useMemo(
    () => allCandidates(snapshot.data?.modules, uiPages.data?.pages),
    [snapshot.data?.modules, uiPages.data?.pages],
  );

  const results = useMemo(() => match(candidates, query), [candidates, query]);
  // 结果随输入变化后，光标可能越界；回零而不是夹住——夹住会停留在看不见的高位
  useEffect(() => {
    setCursor(0);
  }, [query]);

  const pick = (target: Page) => {
    setOpen(false);
    if (target !== page) navigate(target);
  };

  return (
    <Modal
      open={open}
      onCancel={() => setOpen(false)}
      footer={null}
      closable={false}
      destroyOnHidden
      width={420}
      styles={{ body: { padding: 0 } }}
    >
      <div role="dialog" aria-label="全局搜索">
        <Input
          ref={inputRef as never}
          allowClear
          prefix={<SearchOutlined style={{ color: face.text3 }} />}
          placeholder="搜索页面：入库、库存、流程…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setOpen(false);
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              setCursor((cur) => Math.min(cur + 1, results.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setCursor((cur) => Math.max(cur - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const hit = results[cursor] ?? results[0];
              if (hit) pick(hit.page);
            }
          }}
          style={{ padding: '10px 12px', fontSize: 14 }}
        />
        <div style={{ maxHeight: 320, overflowY: 'auto', padding: 4 }}>
          {results.length === 0 ? (
            <div style={{ padding: '16px 12px', fontSize: 12, color: face.text3 }}>
              没有匹配的页面（候选共 {candidates.length} 个）
            </div>
          ) : (
            results.map((item, index) => (
              <button
                key={item.page}
                type="button"
                data-testid="palette-result"
                onClick={() => pick(item.page)}
                onMouseEnter={() => setCursor(index)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '8px 10px',
                  border: 'none',
                  borderRadius: 6,
                  background: index === cursor ? face.raised : 'transparent',
                  color: face.ink,
                  cursor: 'pointer',
                  font: 'inherit',
                  textAlign: 'left',
                }}
              >
                <item.icon style={{ fontSize: 14, color: face.text2 }} />
                <span style={{ fontSize: 13 }}>{item.label}</span>
                <span style={{ marginLeft: 'auto', fontSize: 12, color: face.text3 }}>{item.hint}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}

/** 内置项（按模块开关过滤）+ 动态页，hint 取分组名或大类名 */
function allCandidates(
  modules: Record<string, { enabled?: boolean }> | undefined,
  pages: readonly { id: string; label: string; icon?: string }[] | undefined,
): Candidate[] {
  const builtin: Candidate[] = [];
  for (const category of NAV_CATEGORIES) {
    for (const item of category.items) {
      if (item.moduleId != null && modules?.[item.moduleId]?.enabled !== true) continue;
      builtin.push({ page: item.page, label: item.label, hint: item.group ?? category.label, icon: item.icon });
    }
  }
  const dynamic: Candidate[] = (pages ?? []).map((item) => ({
    page: item.id,
    label: item.label,
    hint: '模块页面',
    icon: navIconFor(item.icon),
  }));
  return [...builtin, ...dynamic];
}

function match(candidates: readonly Candidate[], query: string): Candidate[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return candidates.slice(0, MAX_RESULTS);
  return candidates
    .filter((item) => `${item.label} ${item.page} ${item.hint}`.toLowerCase().includes(keyword))
    .slice(0, MAX_RESULTS);
}
