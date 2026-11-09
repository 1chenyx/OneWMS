import { useState } from 'react';
import { Button, Tag, Typography } from 'antd';
import type { ProposeResponse } from '../api/profile-api';
import { humanizeImpact } from '../lib/module-present';

/**
 * 贴在被拨动的方块或卡片旁边。生效后才写入，撤销则放弃这次提议。
 */

const STYLE = `
.change-confirm {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #f6ffed;
  border: 1px solid #b7eb8f;
}
.change-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.change-confirm-items {
  margin: 8px 0 0;
  padding-left: 18px;
}
`;

export default function ChangeConfirm({
  text,
  report,
  confirming,
  onDismiss,
  onApply,
  nameOf,
}: {
  text: string;
  report: ProposeResponse['report'] | undefined;
  confirming: boolean;
  onDismiss: () => void;
  onApply: () => void;
  nameOf: (id: string) => string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="change-confirm" role="region" aria-label="确认这次修改">
      <style>{STYLE}</style>
      <Typography.Paragraph style={{ marginBottom: 0 }}>{text}</Typography.Paragraph>
      <div className="change-confirm-actions">
        {report ? (
          <Button type="link" onClick={() => setOpen((value) => !value)} disabled={confirming}>
            {open ? '收起细节' : '查看细节'}
          </Button>
        ) : null}
        <Button onClick={onDismiss} disabled={confirming}>
          撤销
        </Button>
        <Button type="primary" loading={confirming} disabled={!report} onClick={onApply}>
          生效
        </Button>
      </div>
      {open && report ? (
        <>
          <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0' }}>
            {humanizeImpact(report.summary, nameOf)}
          </Typography.Paragraph>
          <ul className="change-confirm-items">
            {report.items.map((item, index) => (
              <li key={`${item.kind}-${index}`}>
                <Tag color={item.severity === 'warning' ? 'orange' : 'blue'} bordered={false}>
                  {item.severity === 'warning' ? '注意' : '变更'}
                </Tag>
                {humanizeImpact(item.description, nameOf)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
