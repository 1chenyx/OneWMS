import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Modal, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { api } from '../api/client';
import type { ReplenishmentSuggestion } from '../api/client';
import { fmtQty } from '../lib/format';
import { monoCell, numCell } from './table-style';

/**
 * 按缺口生成一张普通入库单（module.replenish）。
 * 建议只在弹窗打开时拉，库存页本身仍只显示低库存预警。
 */
export default function ReplenishModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const suggestions = useQuery({
    queryKey: ['replenishment'],
    queryFn: () => api.replenishment(),
    enabled: open,
  });
  const [picked, setPicked] = useState<string[] | null>(null);
  const create = useMutation({
    mutationFn: (skuCodes: string[]) => api.createReplenishment({ skuCodes }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['replenishment'] });
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      message.success(`已开入库单 ${created.orderNo}，这是一张普通入库单，收货后才会加库存`);
      onClose();
    },
    onError: (error: unknown) => {
      message.error(error instanceof Error ? error.message : String(error));
    },
  });

  useEffect(() => {
    if (!open) setPicked(null);
  }, [open]);

  const rows = suggestions.data ?? [];
  const selected = picked ?? rows.map((row) => row.skuCode);

  const submit = () => {
    if (suggestions.isLoading || suggestions.isError) return;
    if (selected.length === 0) {
      message.warning('请至少选择一个商品');
      return;
    }
    create.mutate(selected);
  };

  const columns: ColumnsType<ReplenishmentSuggestion> = [
    { title: '编码', dataIndex: 'skuCode', key: 'skuCode', onCell: monoCell },
    { title: '名称', dataIndex: 'name', key: 'name' },
    {
      title: '可用',
      dataIndex: 'available',
      key: 'available',
      align: 'right',
      onCell: numCell,
      render: (v: number, row) => fmtQty(v, row.unit),
    },
    {
      title: '安全库存',
      dataIndex: 'reorderPoint',
      key: 'reorderPoint',
      align: 'right',
      onCell: numCell,
      render: (v: number, row) => fmtQty(v, row.unit),
    },
    {
      title: '未收货',
      dataIndex: 'inboundOpen',
      key: 'inboundOpen',
      align: 'right',
      onCell: numCell,
      render: (v: number, row) => fmtQty(v, row.unit),
    },
    {
      title: '建议数量',
      dataIndex: 'suggestedQty',
      key: 'suggestedQty',
      align: 'right',
      onCell: numCell,
      render: (v: number, row) => fmtQty(v, row.unit),
    },
  ];

  return (
    <Modal
      title="生成补货单"
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="生成"
      confirmLoading={create.isPending}
      okButtonProps={{ disabled: suggestions.isLoading || rows.length === 0 }}
      width={720}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        勾选要补的商品。生成的是普通入库单，收货后才会加库存。
      </Typography.Paragraph>
      {suggestions.isError ? (
        <Typography.Text type="danger">
          {suggestions.error instanceof Error ? suggestions.error.message : '补货建议加载失败'}
        </Typography.Text>
      ) : null}
      {!suggestions.isLoading && !suggestions.isError && rows.length === 0 ? (
        <Typography.Text>没有需要补的货</Typography.Text>
      ) : null}
      {rows.length > 0 ? (
        <Table<ReplenishmentSuggestion>
          rowKey="skuCode"
          size="small"
          pagination={false}
          columns={columns}
          dataSource={rows}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: (keys) => setPicked(keys.map(String)),
          }}
        />
      ) : null}
    </Modal>
  );
}
