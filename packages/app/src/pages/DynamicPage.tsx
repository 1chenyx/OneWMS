import type { ComponentType } from 'react';
import { Result, Spin } from 'antd';
import type { UiPageKind } from '@one/core';
import type { UiPageDescriptor } from '../api/client';
import { useUiPages } from '../api/hooks';
import { useAppNav } from '../app-nav';
import RecordListPage from './RecordListPage';

/**
 * 声明式模块页面的宿主（B.6）。
 *
 * App.tsx 的页面表只认内置 key；查不到就落到这里，由当前 page key 去
 * /api/ui/pages 的清单里找描述，再按 kind 挑渲染器。
 *
 * ⚠️ 所有分支都必须渲染出东西（而不是抛错）：page key 是运行时字符串，
 *    「导航里有这一项但清单里找不到」在装卸模块的间隙是真会发生的
 *    （清单请求失败、模块刚被停用、旧书签指向已卸载的页面）。
 *    本项目没开 noUncheckedIndexedAccess，索引不到不会报错，只会白屏——
 *    白屏比一句「页面不存在」难查得多。
 */

/**
 * kind → 渲染器。
 * Partial 是故意的：服务端可能下发本前端还不认识的 kind（新模块配旧前端），
 * 这时要落到下面的兜底提示，而不是索引出一个 undefined 组件把整页炸掉。
 */
const KIND_RENDERERS: Partial<Record<UiPageKind, ComponentType<{ descriptor: UiPageDescriptor }>>> = {
  'record-list': RecordListPage,
};

export default function DynamicPage() {
  const { page } = useAppNav();
  const { data, isLoading, isError } = useUiPages();
  const descriptor = data?.pages.find((item) => item.id === page);

  if (isLoading) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }
  if (isError || !descriptor) {
    return (
      <Result
        status="warning"
        title="页面不可用"
        subTitle={
          isError
            ? '页面清单加载失败，请检查服务端连接后重试'
            : `没有找到页面「${page}」。它可能来自已卸载或已停用的模块。`
        }
      />
    );
  }
  const Renderer = KIND_RENDERERS[descriptor.kind];
  if (!Renderer) {
    return (
      <Result
        status="warning"
        title="暂不支持这种页面"
        subTitle={`页面「${descriptor.label}」的形态是 ${String(descriptor.kind)}，当前前端还不认识。请升级前端或联系模块作者。`}
      />
    );
  }
  // key 用页面 id：在同一宿主里切页面时强制重挂载，避免上一个页面的过滤/分页状态串味
  return <Renderer key={descriptor.id} descriptor={descriptor} />;
}
