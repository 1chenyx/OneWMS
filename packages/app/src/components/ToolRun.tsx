import { useState } from 'react';
import { Typography } from 'antd';
import type { ChatInvocation } from '../api/client';
import type { InitialFilter, Page } from '../app-nav';
import { speakRun } from '../chat/tool-speak';
import ToolInvocationCard from './ToolInvocationCard';

/**
 * 一轮里连续的工具调用收成一条。默认只显示概括，展开后才看每条说明和表格。
 */
export default function ToolRun({
  invocations,
  onNavigate,
}: {
  invocations: ChatInvocation[];
  onNavigate?: (page: Page, filter?: InitialFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const summary = speakRun(invocations);
  const failed = invocations.some((inv) => inv.ok === false);
  const label = open ? '收起' : '展开';

  return (
    <div style={{ background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 8 }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={{
          display: 'block',
          width: '100%',
          textAlign: 'left',
          background: 'transparent',
          border: 0,
          padding: '6px 10px',
          cursor: 'pointer',
        }}
      >
        <Typography.Text type="secondary">{label}</Typography.Text>
        <Typography.Text type={failed ? 'danger' : undefined} style={{ marginLeft: 8 }}>
          {summary}
        </Typography.Text>
      </button>
      {open ? (
        <div style={{ padding: '0 10px 8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {invocations.map((inv) => (
            <ToolInvocationCard
              key={inv.callId}
              invocation={inv}
              onNavigate={onNavigate}
              hideTitle={invocations.length === 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
