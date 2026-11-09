import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Card, Form, Input, InputNumber, Modal, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useProfileSnapshot } from '../api/hooks';
import { api, ApiError } from '../api/client';
import type { LpnRow, LpnStockLine } from '../api/client';
import { useAppNav } from '../app-nav';
import PageHeader from '../components/PageHeader';
import { TABLE_PAGINATION, monoCell, numCell } from '../components/table-style';

/**
 * 托盘页。托盘占用已有库位上的货，移托盘时整托一起走。
 * 清单是主界面；新建、装托、卸托、移动各自用弹窗，不堆在库存页上。
 */

interface ContentFields {
  skuCode: string;
  quantity: number;
  batchNo?: string;
  serials?: string;
}

function splitSerials(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/[\s,，]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function contentBody(values: ContentFields): {
  skuCode: string;
  quantity: number;
  batchNo?: string;
  serials?: string[];
} {
  const serials = splitSerials(values.serials);
  const batchNo = values.batchNo?.trim();
  return {
    skuCode: values.skuCode.trim(),
    quantity: values.quantity,
    ...(batchNo ? { batchNo } : {}),
    ...(serials.length > 0 ? { serials } : {}),
  };
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

export default function PalletsPage() {
  const { message } = AntApp.useApp();
  const { takeInitialFilter } = useAppNav();
  const snapshot = useProfileSnapshot();
  const lpnOn = snapshot.data?.modules['module.lpn']?.enabled === true;
  const serialOn = snapshot.data?.modules['module.serial']?.enabled === true;
  const queryClient = useQueryClient();
  const [createForm] = Form.useForm<{ lpnCode: string; locationCode?: string }>();
  const [contentForm] = Form.useForm<ContentFields>();
  const [moveForm] = Form.useForm<{ toLocationCode: string }>();
  const [selected, setSelected] = useState<string | null>(() => takeInitialFilter()?.lpnCode ?? null);
  const [createOpen, setCreateOpen] = useState(false);
  const [contentMode, setContentMode] = useState<'pack' | 'unpack' | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);

  const lpns = useQuery({
    queryKey: ['lpns'],
    queryFn: () => api.lpns(),
    enabled: lpnOn,
  });
  const stock = useQuery({
    queryKey: ['lpn-stock', selected ?? ''],
    queryFn: () => api.lpnStock(selected ?? ''),
    enabled: lpnOn && selected != null && selected.length > 0,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['lpns'] });
    void queryClient.invalidateQueries({ queryKey: ['lpn-stock'] });
    void queryClient.invalidateQueries({ queryKey: ['serials'] });
    void queryClient.invalidateQueries({ queryKey: ['inventory'] });
  };
  const fail = (caught: unknown, fallback: string) => message.error(errorText(caught, fallback));

  const create = useMutation({
    mutationFn: (values: { lpnCode: string; locationCode?: string }) => {
      const locationCode = values.locationCode?.trim();
      return api.createLpn({
        lpnCode: values.lpnCode.trim(),
        ...(locationCode ? { locationCode } : {}),
      });
    },
    onSuccess: (created) => {
      refresh();
      setSelected(created.lpnCode);
      setCreateOpen(false);
      message.success(`托盘 ${created.lpnCode} 已建在 ${created.locationCode}`);
    },
    onError: (caught: unknown) => fail(caught, '创建托盘失败'),
  });
  const pack = useMutation({
    mutationFn: (values: ContentFields) => api.packLpn(selected ?? '', contentBody(values)),
    onSuccess: (packed) => {
      refresh();
      setContentMode(null);
      message.success(`${packed.lpnCode} 已装入 ${packed.skuCode}，托上共 ${packed.quantity}`);
    },
    onError: (caught: unknown) => fail(caught, '装托失败'),
  });
  const unpack = useMutation({
    mutationFn: (values: ContentFields) => api.unpackLpn(selected ?? '', contentBody(values)),
    onSuccess: (unpacked) => {
      refresh();
      setContentMode(null);
      message.success(`${unpacked.lpnCode} 已卸下 ${unpacked.skuCode}，托上还剩 ${unpacked.quantity}`);
    },
    onError: (caught: unknown) => fail(caught, '卸托失败'),
  });
  const move = useMutation({
    mutationFn: (values: { toLocationCode: string }) =>
      api.moveLpn(selected ?? '', { toLocationCode: values.toLocationCode.trim() }),
    onSuccess: (moved) => {
      refresh();
      setMoveOpen(false);
      message.success(`托盘 ${moved.lpnCode} 已从 ${moved.from} 移到 ${moved.to}`);
    },
    onError: (caught: unknown) => fail(caught, '移托盘失败'),
  });

  const columns: ColumnsType<LpnRow> = [
    { title: '托盘', dataIndex: 'lpnCode', key: 'lpnCode', onCell: monoCell },
    { title: '库位', dataIndex: 'locationCode', key: 'locationCode', onCell: monoCell },
    { title: '行数', dataIndex: 'lineCount', key: 'lineCount', align: 'right', onCell: numCell, width: 90 },
  ];
  const lineColumns: ColumnsType<LpnStockLine> = [
    { title: 'SKU', dataIndex: 'skuCode', key: 'skuCode', onCell: monoCell },
    { title: '批次', dataIndex: 'batchNo', key: 'batchNo', onCell: monoCell },
    { title: '数量', dataIndex: 'quantity', key: 'quantity', align: 'right', onCell: numCell, width: 120 },
  ];
  const rows = lpns.data ?? [];
  const current = rows.find((row) => row.lpnCode === selected) ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      <PageHeader
        title="托盘"
        subtitle="托盘占用某个库位上已经有的货。移动时整托一起走，不另算一套库存。"
        extra={
          lpnOn ? (
            <Button type="primary" onClick={() => setCreateOpen(true)}>
              新建托盘
            </Button>
          ) : null
        }
      />
      {snapshot.isSuccess && !lpnOn ? (
        <Card>托盘已关闭。到设置里重新启用 module.lpn 后可以装托和按托盘移库。</Card>
      ) : (
        <>
          <Card>
            {lpns.error ? (
              <Typography.Paragraph type="danger">{errorText(lpns.error, '托盘加载失败')}</Typography.Paragraph>
            ) : null}
            <Table<LpnRow>
              rowKey="lpnCode"
              columns={columns}
              dataSource={rows}
              loading={lpnOn && lpns.isLoading}
              pagination={TABLE_PAGINATION}
              locale={{ emptyText: '还没有托盘' }}
              onRow={(row) => ({
                onClick: () => setSelected(row.lpnCode),
                style: { cursor: 'pointer' },
              })}
              rowClassName={(row) => (row.lpnCode === selected ? 'ant-table-row-selected' : '')}
            />
          </Card>
          {selected ? (
            <Card
              title={`${selected}${current ? ` · ${current.locationCode}` : ''}`}
              extra={
                <Space>
                  <Button onClick={() => setContentMode('pack')}>装托</Button>
                  <Button onClick={() => setContentMode('unpack')}>卸托</Button>
                  <Button onClick={() => setMoveOpen(true)}>移动</Button>
                </Space>
              }
            >
              {stock.error ? (
                <Typography.Paragraph type="danger">{errorText(stock.error, '托盘库存加载失败')}</Typography.Paragraph>
              ) : null}
              <Table<LpnStockLine>
                rowKey={(row) => `${row.skuCode}:${row.batchNo}`}
                size="small"
                columns={lineColumns}
                dataSource={stock.data?.lines ?? []}
                loading={stock.isLoading}
                pagination={TABLE_PAGINATION}
                locale={{ emptyText: '这个托盘是空的' }}
              />
            </Card>
          ) : (
            <Typography.Text type="secondary">点一个托盘，查看上面的货，或装托、卸托、移动。</Typography.Text>
          )}
        </>
      )}

      <Modal
        title="新建托盘"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
        confirmLoading={create.isPending}
        destroyOnHidden
      >
        <Form
          form={createForm}
          layout="vertical"
          onFinish={(values) => create.mutate(values)}
        >
          <Form.Item name="lpnCode" label="托盘号" rules={[{ required: true, message: '填写托盘号' }]}>
            <Input placeholder="如 P-1" />
          </Form.Item>
          <Form.Item name="locationCode" label="库位（可选）">
            <Input placeholder="空着就是 DEFAULT" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={contentMode === 'unpack' ? `从 ${selected ?? ''} 卸托` : `装上 ${selected ?? ''}`}
        open={contentMode != null}
        onCancel={() => setContentMode(null)}
        onOk={() => contentForm.submit()}
        confirmLoading={contentMode === 'unpack' ? unpack.isPending : pack.isPending}
        destroyOnHidden
      >
        <Form
          form={contentForm}
          layout="vertical"
          onFinish={(values) => (contentMode === 'unpack' ? unpack.mutate(values) : pack.mutate(values))}
        >
          <Form.Item name="skuCode" label="SKU" rules={[{ required: true, message: '填写 SKU' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="quantity" label="数量" rules={[{ required: true, message: '填写数量' }]}>
            <InputNumber min={0.001} precision={3} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="batchNo" label="批次（可选）">
            <Input placeholder="空着就是 DEFAULT" />
          </Form.Item>
          {serialOn ? (
            <Form.Item name="serials" label="序列号（按件管理时必填）">
              <Input.TextArea rows={3} placeholder="每行一个，或用逗号、空格分开" />
            </Form.Item>
          ) : null}
        </Form>
      </Modal>
      <Modal
        title={`移动 ${selected ?? ''}`}
        open={moveOpen}
        onCancel={() => setMoveOpen(false)}
        onOk={() => moveForm.submit()}
        confirmLoading={move.isPending}
        destroyOnHidden
      >
        <Form form={moveForm} layout="vertical" onFinish={(values) => move.mutate(values)}>
          <Form.Item name="toLocationCode" label="目标库位" rules={[{ required: true, message: '填写目标库位' }]}>
            <Input placeholder="如 B-02" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
