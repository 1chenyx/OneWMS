import { useEffect, useState } from 'react';
import { PlusOutlined } from '@ant-design/icons';
import {
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Radio,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  useCancelStocktake,
  useCloseStocktake,
  useCountStocktake,
  useCreateStocktake,
  useLocations,
  useSkus,
  useStocktakeDetail,
  useStocktakes,
} from '../api/hooks';
import { ApiError } from '../api/client';
import type { Stocktake, StocktakeLine } from '../api/client';
import ScanInput from '../components/ScanInput';
import PageHeader from '../components/PageHeader';
import { TABLE_PAGINATION, monoCell, numCell } from '../components/table-style';
import { fmtQty } from '../lib/format';

/**
 * 盘点页（M17）：清单（状态 + 范围 + 进度）→ 新建（范围勾选）→ 明细
 * （逐桶录实盘数，失焦/回车即提交）→ 关单（差异自动收敛为库存调整）。
 * 写操作全走工具总线（wms.stocktake.*）——护栏（范围校验 / 全行已盘 /
 * 状态机）在服务端 handler，UI 只按 code 提示。
 */

const STATE_TAG: Record<string, { color: string; label: string }> = {
  created: { color: 'processing', label: '盘点中' },
  closed: { color: 'green', label: '已关单' },
  canceled: { color: 'default', label: '已取消' },
};

export default function StocktakePage() {
  const { message } = AntApp.useApp();
  const { data: rows, isLoading } = useStocktakes();
  const close = useCloseStocktake();
  const cancel = useCancelStocktake();
  const [createOpen, setCreateOpen] = useState(false);
  const [detailNo, setDetailNo] = useState<string | null>(null);

  const doClose = async (no: string) => {
    try {
      const r = await close.mutateAsync(no);
      message.success(
        r.adjustedLines > 0
          ? `${no} 已关单：${r.adjustedLines}/${r.totalLines} 行有差异，已调整库存`
          : `${no} 已关单：账实相符，零调整`,
      );
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `关单失败：${String(e)}`);
    }
  };

  const doCancel = async (no: string) => {
    try {
      await cancel.mutateAsync(no);
      message.success(`${no} 已取消（未调整库存）`);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `取消失败：${String(e)}`);
    }
  };

  const columns: ColumnsType<Stocktake> = [
    { title: '盘点单号', dataIndex: 'stocktakeNo', key: 'stocktakeNo', onCell: monoCell },
    {
      title: '状态',
      dataIndex: 'state',
      key: 'state',
      render: (v: string) => (
        <Tag color={STATE_TAG[v]?.color ?? 'default'}>{STATE_TAG[v]?.label ?? v}</Tag>
      ),
    },
    {
      title: '范围',
      key: 'scope',
      render: (_, r) =>
        r.scope === '全场' ? <Tag>全场</Tag> : r.scope.join('，'),
    },
    {
      title: '进度',
      key: 'progress',
      render: (_, r) =>
        r.state === 'created' && r.lineCount > 0 ? (
          <Progress
            percent={Math.round((r.countedCount / r.lineCount) * 100)}
            size="small"
            format={() => `${r.countedCount}/${r.lineCount}`}
          />
        ) : (
          `${r.countedCount}/${r.lineCount}`
        ),
    },
    { title: '备注', dataIndex: 'note', key: 'note', render: (v: string | null) => v ?? '-' },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (v: string) => v.slice(0, 19).replace('T', ' '),
      sorter: (a, b) => a.createdAt.localeCompare(b.createdAt),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_, r) => (
        <Space size="small" wrap>
          <Button size="small" onClick={() => setDetailNo(r.stocktakeNo)}>
            明细
          </Button>
          {r.state === 'created' ? (
            <>
              <Popconfirm
                title="确认关单？"
                description="将按实盘数与当前账面的差异自动调整库存"
                onConfirm={() => doClose(r.stocktakeNo)}
              >
                <Button
                  size="small"
                  type="primary"
                  loading={close.isPending && close.variables === r.stocktakeNo}
                >
                  关单
                </Button>
              </Popconfirm>
              <Popconfirm
                title="确认取消该盘点单？（不调整库存）"
                onConfirm={() => doCancel(r.stocktakeNo)}
              >
                <Button
                  size="small"
                  danger
                  loading={cancel.isPending && cancel.variables === r.stocktakeNo}
                >
                  取消
                </Button>
              </Popconfirm>
            </>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      <PageHeader
        title="盘点"
        subtitle="录实盘数，关单自动按差异调整库存"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建盘点
          </Button>
        }
      />
      <Card>
        <Table<Stocktake>
          rowKey="id"
          columns={columns}
          dataSource={rows ?? []}
          loading={isLoading}
          pagination={TABLE_PAGINATION}
          locale={{ emptyText: '还没有盘点单' }}
        />
        <CreateStocktakeModal open={createOpen} onClose={() => setCreateOpen(false)} />
        <StocktakeDetailModal no={detailNo} onClose={() => setDetailNo(null)} />
      </Card>
    </div>
  );
}

/**
 * 新建盘点：范围（全场 = 含默认库位 DEFAULT；指定库位 = 勾选，DEFAULT 可显式勾入）
 * + 备注。创建即生成待盘明细行（按当时账面余量快照）。
 */
function CreateStocktakeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const scopeMode = Form.useWatch('scopeMode', form);
  const create = useCreateStocktake();
  const { data: locations } = useLocations();

  const submit = async (values: {
    scopeMode: 'all' | 'scoped';
    locationCodes?: string[];
    note?: string;
  }) => {
    if (values.scopeMode === 'scoped' && (!values.locationCodes || values.locationCodes.length === 0)) {
      message.error('指定库位模式请至少勾选一个库位');
      return;
    }
    try {
      const r = await create.mutateAsync({
        locationCodes: values.scopeMode === 'scoped' ? values.locationCodes : undefined,
        note: values.note || undefined,
      });
      message.success(`盘点单 ${r.stocktakeNo} 已创建：待盘 ${r.lineCount} 行`);
      onClose();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `创建失败：${String(e)}`);
    }
  };

  return (
    <Modal
      title="新建盘点"
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={create.isPending}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        创建时立即按当前账面余量生成待盘明细行（每个有余量的 SKU×库位×批次桶一行）。
      </Typography.Paragraph>
      <Form form={form} layout="vertical" onFinish={submit} initialValues={{ scopeMode: 'all' }}>
        <Form.Item name="scopeMode" label="盘点范围">
          <Radio.Group
            options={[
              { value: 'all', label: '全场盘点（含默认库位 DEFAULT）' },
              { value: 'scoped', label: '指定库位' },
            ]}
          />
        </Form.Item>
        {scopeMode === 'scoped' ? (
          <Form.Item name="locationCodes" label="勾选库位">
            <Checkbox.Group
              options={[
                { label: 'DEFAULT（默认库位，未指定库位库存的归宿）', value: 'DEFAULT' },
                ...(locations ?? []).map((l) => ({
                  label: `${l.locationCode} · ${l.name}`,
                  value: l.locationCode,
                })),
              ]}
            />
          </Form.Item>
        ) : null}
        <Form.Item name="note" label="备注（可选，如 月度大盘）">
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/**
 * 盘点明细：逐行账面快照 / 实盘数 / 当前账面 / 差异。盘点中可录实盘——
 * 失焦或回车即提交（每次录入 = 一条 counted 事件，重盘后到者胜）。
 * 草稿 keyed by 单号+桶：切换单据不串行；未修改的行不会重复提交。
 * 扫码定位（M18）：扫条码（或编码）把明细过滤到该 SKU 的行——同 SKU 多桶
 * （多库位/批次）全部列出供逐桶录数；Tag 可点 × 清除恢复全表。
 */
function StocktakeDetailModal({ no, onClose }: { no: string | null; onClose: () => void }) {
  const { message } = AntApp.useApp();
  const detail = useStocktakeDetail(no);
  const count = useCountStocktake();
  const close = useCloseStocktake();
  const { data: skus } = useSkus();
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const [scanFilter, setScanFilter] = useState('');

  const isOpen = detail.data?.state === 'created';
  const lineKey = (l: StocktakeLine) => `${no}:${l.skuCode}@${l.locationCode}@${l.batchNo}`;

  // 切换单据/关闭时清空扫码过滤（草稿 keyed by 单号+桶，天然不串行）
  useEffect(() => {
    setScanFilter('');
  }, [no]);

  const handleScan = (code: string) => {
    // 条码优先，编码兜底（扫的可能是商品条码，手工输的可能是编码）
    const sku = (skus ?? []).find((s) => s.barcode === code) ?? (skus ?? []).find((s) => s.skuCode === code);
    if (!sku) {
      message.warning(`没有条码/编码为 ${code} 的 SKU`);
      return;
    }
    const hit = (detail.data?.lines ?? []).filter((l) => l.skuCode === sku.skuCode);
    if (hit.length === 0) {
      message.warning(`SKU ${sku.skuCode} 不在盘点明细中`);
      return;
    }
    setScanFilter(sku.skuCode);
  };

  const commit = (line: StocktakeLine) => {
    if (!no) return;
    const v = drafts[lineKey(line)];
    if (v === undefined || v === line.countedQty) return; // 未修改不提交
    count
      .mutateAsync({
        no,
        body: {
          skuCode: line.skuCode,
          locationCode: line.locationCode,
          batchNo: line.batchNo,
          countedQty: v,
        },
      })
      .then(() => message.success(`${line.skuCode} 实盘数已记录：${v}`))
      .catch((e) =>
        message.error(e instanceof ApiError ? e.message : `录入失败：${String(e)}`),
      );
  };

  const doClose = async () => {
    if (!no) return;
    try {
      const r = await close.mutateAsync(no);
      message.success(
        r.adjustedLines > 0
          ? `${no} 已关单：${r.adjustedLines}/${r.totalLines} 行有差异，已调整库存`
          : `${no} 已关单：账实相符，零调整`,
      );
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `关单失败：${String(e)}`);
    }
  };

  const columns: ColumnsType<StocktakeLine> = [
    { title: 'SKU', dataIndex: 'skuCode', key: 'skuCode', onCell: monoCell },
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '库位', dataIndex: 'locationCode', key: 'locationCode', onCell: monoCell },
    { title: '批次', dataIndex: 'batchNo', key: 'batchNo', onCell: monoCell },
    {
      title: '账面快照',
      dataIndex: 'expectedQty',
      key: 'expectedQty',
      align: 'right',
      onCell: numCell,
      render: (v: number, l) => fmtQty(v, l.unit),
    },
    {
      title: '实盘数',
      key: 'countedQty',
      align: 'right',
      onCell: numCell,
      render: (_, l) =>
        isOpen ? (
          <InputNumber
            size="small"
            min={0}
            precision={3}
            placeholder="待盘"
            value={drafts[lineKey(l)] ?? l.countedQty ?? undefined}
            onChange={(v) => {
              if (v !== null) setDrafts((d) => ({ ...d, [lineKey(l)]: v }));
            }}
            onBlur={() => commit(l)}
            onPressEnter={() => commit(l)}
          />
        ) : (
          (l.countedQty !== null ? fmtQty(l.countedQty, l.unit) : '未盘')
        ),
    },
    {
      title: '当前账面',
      dataIndex: 'bookQty',
      key: 'bookQty',
      align: 'right',
      onCell: numCell,
      render: (v: number, l) => fmtQty(v, l.unit),
    },
    {
      title: '差异',
      key: 'delta',
      align: 'right',
      onCell: numCell,
      render: (_, l) => {
        const counted = drafts[lineKey(l)] ?? l.countedQty;
        if (counted === null || counted === undefined) {
          return <Typography.Text type="secondary">—</Typography.Text>;
        }
        const delta = counted - l.bookQty;
        if (delta === 0) return <Typography.Text type="secondary">0</Typography.Text>;
        return (
          <Typography.Text type={delta > 0 ? 'success' : 'danger'}>
            {delta > 0 ? `+${delta}` : delta}
          </Typography.Text>
        );
      },
    },
  ];

  const d = detail.data;
  return (
    <Modal
      title={no ? `盘点明细：${no}` : '盘点明细'}
      open={no !== null}
      onCancel={onClose}
      width={860}
      footer={
        <Space>
          {d && d.state === 'created' ? (
            <Popconfirm
              title="确认关单？"
              description="将按实盘数与当前账面的差异自动调整库存"
              onConfirm={doClose}
            >
              <Button type="primary" loading={close.isPending}>
                关单
              </Button>
            </Popconfirm>
          ) : null}
          <Button onClick={onClose}>关闭</Button>
        </Space>
      }
    >
      {d ? (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Space size="large" wrap>
            <Tag color={STATE_TAG[d.state]?.color ?? 'default'}>
              {STATE_TAG[d.state]?.label ?? d.state}
            </Tag>
            <Typography.Text>范围：{d.scope === '全场' ? '全场' : d.scope.join('，')}</Typography.Text>
            <Typography.Text>
              进度：{d.countedCount}/{d.lineCount}
            </Typography.Text>
            {d.note ? <Typography.Text type="secondary">备注：{d.note}</Typography.Text> : null}
          </Space>
          <Space wrap>
            <ScanInput onScan={handleScan} placeholder="扫码定位 SKU 行（条码或编码）" />
            {scanFilter ? (
              <Tag closable onClose={() => setScanFilter('')} color="blue">
                只显示 {scanFilter}
              </Tag>
            ) : null}
          </Space>
          <Table<StocktakeLine>
            rowKey={(l) => `${l.skuCode}@${l.locationCode}@${l.batchNo}`}
            columns={columns}
            dataSource={scanFilter ? d.lines.filter((l) => l.skuCode === scanFilter) : d.lines}
            pagination={false}
            size="small"
            locale={{ emptyText: scanFilter ? `没有 ${scanFilter} 的待盘行` : '范围内没有待盘的库存桶' }}
          />
          {isOpen ? (
            <Typography.Text type="secondary">
              实盘数输入后失焦或回车即保存；同桶重盘后录覆盖先录。全部行录完后即可关单。
            </Typography.Text>
          ) : null}
        </Space>
      ) : (
        <Typography.Text type="secondary">加载中…</Typography.Text>
      )}
    </Modal>
  );
}
