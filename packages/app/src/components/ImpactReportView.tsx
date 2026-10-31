import type { ImpactReport } from '@one/core';
import { Alert, List, Tag, Typography } from 'antd';

/**
 * 影响报告渲染（§7.3 确认界面的核心）：
 * 条目由后端生成（中文 description 直出），前端只负责分级着色与排版——
 * 不在前端重新计算 diff（「报告所见即应用所得」由后端新鲜度检查保证）。
 */
export default function ImpactReportView({ report }: { report: ImpactReport }) {
  return (
    <div>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        {report.summary}
      </Typography.Paragraph>
      <List
        dataSource={report.items}
        renderItem={(item) => (
          <List.Item style={{ padding: '6px 0' }}>
            <Alert
              style={{ width: '100%' }}
              type={item.severity === 'warning' ? 'warning' : 'info'}
              showIcon
              message={
                <>
                  <Tag bordered={false}>{item.kind}</Tag>
                  <Typography.Text>{item.description}</Typography.Text>
                  {item.target ? (
                    <Typography.Text code style={{ marginLeft: 8 }}>
                      {item.target}
                    </Typography.Text>
                  ) : null}
                </>
              }
            />
          </List.Item>
        )}
      />
    </div>
  );
}
