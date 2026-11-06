import type { ReactNode } from 'react';
import { Space, Typography } from 'antd';

/**
 * 页头（P0 界面优化）：标题 + 一句说明 + 右侧动作，统一替代各页 Card 的
 * title/extra——消除「侧边栏选中项与卡片标题重复」的双层框。说明文字承担
 * 页面定位（第一次进页也能看懂这页管什么），动作区与页面主操作对齐。
 * 页面根节点约定：<div flex column gap 16> + PageHeader + 内容 Card。
 */
export default function PageHeader({
  title,
  subtitle,
  extra,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
        flex: 'none',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 0 }}>
          {title}
        </Typography.Title>
        {subtitle ? (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {subtitle}
          </Typography.Text>
        ) : null}
      </div>
      {extra ? <Space wrap>{extra}</Space> : null}
    </div>
  );
}
