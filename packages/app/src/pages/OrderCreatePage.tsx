import { useState } from 'react';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Input, InputNumber, Radio, Select, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ApiError } from '../api/client';
import type { InventoryBucketRow, InventoryRow, Location, Sku } from '../api/client';
import {
  useCreateOrder,
  useInventory,
  useInventoryBuckets,
  useLocations,
  usePartners,
  useProfileSnapshot,
  useSkus,
} from '../api/hooks';
import PageHeader from '../components/PageHeader';
import ScanInput from '../components/ScanInput';
import { fmtQty } from '../lib/format';
import { monoCell, numCell } from '../components/table-style';

/**
 * 新建入库单或出库单。方向由所在页面定死，这一页不再切换。
 * 出库选商品时摊开每一桶的库位、批次、效期和数量。点「用这桶」填上库位和批次。
 * 怎么扣、写了的批次和库位能不能换，缺省跟仓库。这张单可以另选。建议不传，锁定才传。
 * 提交走 wms.order.create。单号由服务端生成。这一步不改库存。
 */

type Direction = 'in' | 'out';

interface LineDraft {
  key: string;
  skuCode: string;
  quantity: number;
  locationCode: string;
  batchNo: string;
  batchExpiryDate: string;
  serialsText: string;
}

const ALLOCATION_LABEL: Record<'strict' | 'fifo' | 'fefo', string> = {
  strict: '严格桶',
  fifo: '先进先出',
  fefo: '先到期先出',
};

function blankLine(): LineDraft {
  return {
    key: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    skuCode: '',
    quantity: 1,
    locationCode: 'DEFAULT',
    batchNo: '',
    batchExpiryDate: '',
    serialsText: '',
  };
}

function splitSerials(text: string): string[] {
  return text
    .split(/[\s,，]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function withScan(lines: LineDraft[], skuCode: string): { lines: LineDraft[]; key: string } {
  const found = lines.findIndex((line) => line.skuCode === skuCode);
  if (found >= 0) {
    const key = lines[found]!.key;
    return {
      key,
      lines: lines.map((line, index) =>
        index === found ? { ...line, quantity: (line.quantity || 0) + 1 } : line,
      ),
    };
  }
  const empty = lines.findIndex((line) => !line.skuCode.trim());
  if (empty >= 0) {
    const key = lines[empty]!.key;
    return {
      key,
      lines: lines.map((line, index) => (index === empty ? { ...line, skuCode, quantity: 1 } : line)),
    };
  }
  const added = { ...blankLine(), skuCode, quantity: 1 };
  return { key: added.key, lines: [...lines, added] };
}

function readAllocation(settings: Record<string, unknown> | undefined): 'strict' | 'fifo' | 'fefo' {
  const value = settings?.defaultAllocation;
  return value === 'fifo' || value === 'fefo' ? value : 'strict';
}

/** 入库批次是收货事实。出库只有按序列号的商品要自己写批次，其余按仓库规则扣。 */
function linePinsBatch(line: LineDraft, direction: Direction, serialOn: boolean, skus: Sku[]): boolean {
  if (direction === 'in') return true;
  if (!serialOn) return false;
  return skus.find((sku) => sku.skuCode === line.skuCode)?.serialTracked === true;
}

export default function OrderCreatePage({
  direction,
  onClose,
}: {
  direction: Direction;
  onClose: () => void;
}) {
  const { message } = AntApp.useApp();
  const create = useCreateOrder();
  const snapshot = useProfileSnapshot();
  const { data: skus } = useSkus();
  const { data: partners } = usePartners();
  const { data: locations } = useLocations();
  const { data: inventory } = useInventory();
  const bucketQuery = useInventoryBuckets(direction === 'out');
  const [asn, setAsn] = useState(false);
  const [partnerCode, setPartnerCode] = useState('');
  const [note, setNote] = useState('');
  const [expectedAt, setExpectedAt] = useState('');
  const [lines, setLines] = useState<LineDraft[]>(() => [blankLine()]);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [allocation, setAllocation] = useState<'warehouse' | 'strict' | 'fifo' | 'fefo'>('warehouse');
  const [batchConstraint, setBatchConstraint] = useState<'prefer' | 'lock'>('prefer');
  const [locationConstraint, setLocationConstraint] = useState<'prefer' | 'lock'>('prefer');

  const modules = snapshot.data?.modules;
  const asnOn = modules?.['module.asn']?.enabled === true;
  const serialOn = modules?.['module.serial']?.enabled === true;
  const reservationOn = modules?.['module.reservation']?.enabled === true;
  const wmsSettings = modules?.['core.wms']?.settings;
  const warehouseAllocation = readAllocation(wmsSettings);
  const blockExpired = wmsSettings?.blockExpiredOutbound === true;
  const inbound = direction === 'in';
  const skuRows = (skus ?? []).filter((sku) => (sku.status ?? 'active') !== 'archived');
  const locationRows = (Array.isArray(locations) ? locations : []) as Location[];
  const stockRows = (Array.isArray(inventory) ? inventory : []) as InventoryRow[];
  const bucketRows = (Array.isArray(bucketQuery.data) ? bucketQuery.data : []) as InventoryBucketRow[];
  const partnerKind = inbound ? 'supplier' : 'customer';
  const partnerOptions = (partners ?? []).filter((partner) => partner.kind === partnerKind);
  const partner = partnerOptions.find((item) => item.partnerCode === partnerCode);
  const locationOptions = [
    { value: 'DEFAULT', label: '默认库位' },
    ...locationRows.map((loc) => ({ value: loc.locationCode, label: `${loc.locationCode} · ${loc.name}` })),
  ];
  const kept = lines.filter((line) => line.skuCode);
  const problems = collectProblems({
    lines: kept,
    skus: skuRows,
    direction,
    asn: inbound && asn,
    expectedAt,
    serialOn,
    allocation: inbound ? 'strict' : allocation === 'warehouse' ? warehouseAllocation : allocation,
  });
  const focused = lines.find((line) => line.key === focusKey && line.skuCode) ?? kept[0] ?? null;

  const handleScan = (code: string) => {
    const sku = skuRows.find((item) => item.barcode === code) ?? skuRows.find((item) => item.skuCode === code);
    if (!sku) {
      const archived = (skus ?? []).find((item) => item.barcode === code || item.skuCode === code);
      message.warning(archived ? `${code} 已停用，不能开进单据` : `没有条码或编码为 ${code} 的商品`);
      return;
    }
    setLines((prev) => {
      const next = withScan(prev, sku.skuCode);
      setFocusKey(next.key);
      return next.lines;
    });
    message.success(`已记入 ${sku.skuCode} · ${sku.name}`);
  };

  const save = async () => {
    if (problems.length > 0) {
      message.warning(problems[0]);
      return;
    }
    const body = {
      direction,
      lines: kept.map((line) => toPayloadLine(line, direction, serialOn)),
      ...(partnerCode ? { partnerCode } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(inbound && asn ? { asn: true as const, ...(expectedAt.trim() ? { expectedAt: expectedAt.trim() } : {}) } : {}),
      ...(!inbound && allocation !== 'warehouse' ? { allocation } : {}),
      ...(!inbound && batchConstraint === 'lock' ? { batchConstraint: 'lock' as const } : {}),
      ...(!inbound && locationConstraint === 'lock' ? { locationConstraint: 'lock' as const } : {}),
    };
    try {
      const created = await create.mutateAsync(body);
      message.success(inbound && asn ? `预报单 ${created.orderNo} 已创建` : `单据 ${created.orderNo} 已创建`);
      onClose();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `创建失败：${String(e)}`);
    }
  };

  const columns: ColumnsType<LineDraft> = [
    {
      title: '商品',
      dataIndex: 'skuCode',
      width: 240,
      render: (_value, line) => (
        <Select
          showSearch
          optionFilterProp="label"
          placeholder="选择商品"
          style={{ width: '100%' }}
          value={line.skuCode || undefined}
          onChange={(value) => {
            patchLine(setLines, line.key, { skuCode: value });
            setFocusKey(line.key);
          }}
          options={skuRows.map((sku) => ({
            value: sku.skuCode,
            label: inbound ? `${sku.skuCode} · ${sku.name}` : outboundSkuLabel(sku, stockRows),
          }))}
        />
      ),
    },
    {
      title: '名称',
      width: 140,
      render: (_value, line) => {
        const sku = skuRows.find((item) => item.skuCode === line.skuCode);
        if (!sku) return <Typography.Text type="secondary">—</Typography.Text>;
        return (
          <div>
            <div>{sku.name}</div>
            {sku.barcode ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {sku.barcode}
              </Typography.Text>
            ) : null}
            {sku.serialTracked && serialOn ? (
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  按序列号
                </Typography.Text>
              </div>
            ) : null}
          </div>
        );
      },
    },
    {
      title: '数量',
      width: 150,
      onCell: numCell,
      render: (_value, line) => {
        const sku = skuRows.find((item) => item.skuCode === line.skuCode);
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <InputNumber
              min={0.001}
              precision={3}
              value={line.quantity}
              style={{ flex: 1 }}
              onChange={(value) => patchLine(setLines, line.key, { quantity: typeof value === 'number' ? value : 0 })}
            />
            {sku?.unit ? <span>{sku.unit}</span> : null}
          </div>
        );
      },
    },
    {
      title: '库位',
      width: 170,
      render: (_value, line) => (
        <Select
          showSearch
          optionFilterProp="label"
          style={{ width: '100%' }}
          value={line.locationCode}
          onChange={(value) => patchLine(setLines, line.key, { locationCode: value })}
          options={locationOptions}
        />
      ),
    },
    {
      title: '批次',
      width: 140,
      onCell: monoCell,
      render: (_value, line) => (
        <Input
          placeholder={
            !inbound && linePinsBatch(line, direction, serialOn, skuRows) ? '按序列号，要写批次' : '空 = 默认批次'
          }
          value={line.batchNo}
          onChange={(e) => patchLine(setLines, line.key, { batchNo: e.target.value })}
        />
      ),
    },
    ...(inbound
      ? [
          {
            title: '效期',
            width: 150,
            render: (_value: unknown, line: LineDraft) => (
              <Input
                placeholder="YYYY-MM-DD"
                value={line.batchExpiryDate}
                onChange={(e) => patchLine(setLines, line.key, { batchExpiryDate: e.target.value })}
              />
            ),
          } satisfies ColumnsType<LineDraft>[number],
        ]
      : [
          {
            title: '可用',
            width: 180,
            render: (_value: unknown, line: LineDraft) => (
              <AvailableCell line={line} stock={stockRows.find((row) => row.skuCode === line.skuCode)} />
            ),
          } satisfies ColumnsType<LineDraft>[number],
        ]),
    ...(serialOn
      ? [
          {
            title: '序列号',
            width: 220,
            render: (_value: unknown, line: LineDraft) => (
              <Input.TextArea
                rows={2}
                placeholder="每行一个，或用逗号、空格分开"
                value={line.serialsText}
                onChange={(e) => patchLine(setLines, line.key, { serialsText: e.target.value })}
              />
            ),
          } satisfies ColumnsType<LineDraft>[number],
        ]
      : []),
    {
      title: '',
      width: 48,
      render: (_value, line) =>
        lines.length > 1 ? (
          <Button
            type="text"
            aria-label="删除明细行"
            icon={<MinusCircleOutlined />}
            onClick={() => setLines((prev) => prev.filter((item) => item.key !== line.key))}
          />
        ) : null,
    },
  ];

  const title = inbound ? '新建入库单' : '新建出库单';
  const subtitle = inbound
    ? asn
      ? '单号在保存时生成。这是到货预报，收到货再收货，那时才加库存。'
      : '单号在保存时生成。保存后待收货，收货才加库存。'
    : reservationOn
      ? '单号在保存时生成。保存后待拣货，拣货占用可用量，发货才扣库存。'
      : '单号在保存时生成。保存后待发货，发货才扣库存。';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      <PageHeader
        title={title}
        subtitle={subtitle}
        extra={
          <>
            <Button onClick={onClose}>返回列表</Button>
            <Button type="primary" loading={create.isPending} onClick={() => void save()}>
              保存单据
            </Button>
          </>
        }
      />
      <Card title="单据">
        {inbound && asnOn ? (
          <div style={{ marginTop: 16 }}>
            <Typography.Text strong>到货情况</Typography.Text>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
              <Choice
                active={!asn}
                title="直接入库"
                detail="货已经到了。保存后待收货，收货时加库存。"
                onClick={() => {
                  setAsn(false);
                  setExpectedAt('');
                }}
              />
              <Choice
                active={asn}
                title="到货预报"
                detail="货还在路上。保存后是已预报，收到再收货。可以写预计到货日。"
                onClick={() => setAsn(true)}
              />
            </div>
            {asn ? (
              <div style={{ marginTop: 12, maxWidth: 280 }}>
                <Typography.Text>预计到货日</Typography.Text>
                <Input
                  aria-label="预计到货日"
                  style={{ marginTop: 4 }}
                  placeholder="YYYY-MM-DD，可以空着"
                  value={expectedAt}
                  onChange={(e) => setExpectedAt(e.target.value)}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        <div style={{ marginTop: 16, maxWidth: 520 }}>
          <Typography.Text strong>{inbound ? '供应商' : '客户'}</Typography.Text>
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ width: '100%', marginTop: 8 }}
            placeholder={inbound ? '选择供应商，可以不填' : '选择客户，可以不填'}
            value={partnerCode || undefined}
            onChange={(value) => setPartnerCode(value ?? '')}
            options={partnerOptions.map((item) => ({
              value: item.partnerCode,
              label: `${item.partnerCode} · ${item.name}`,
            }))}
            notFoundContent={
              <Typography.Text type="secondary">
                还没有{inbound ? '供应商' : '客户'}。到档案里的往来单位新建。
              </Typography.Text>
            }
          />
          {partner ? <PartnerFacts partner={partner} /> : null}
        </div>

        <div style={{ marginTop: 16 }}>
          <Typography.Text strong>备注</Typography.Text>
          <Input.TextArea
            style={{ marginTop: 8 }}
            rows={3}
            placeholder={inbound ? '例如采购单号、到货说明' : '例如客户订单号、发货要求'}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </Card>

      <Card title="明细">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <ScanInput
            size="large"
            onScan={handleScan}
            placeholder="扫条码或编码，回车加入。同一商品再扫一次，数量加 1"
            style={{ flex: '1 1 320px', width: 'auto', maxWidth: 640 }}
          />
          <Button icon={<PlusOutlined />} onClick={() => setLines((prev) => [...prev, blankLine()])}>
            添加明细行
          </Button>
        </div>
        {!inbound ? (
          <div style={{ marginBottom: 12 }}>
            <Typography.Text strong>批次怎么扣</Typography.Text>
            <Radio.Group
              style={{ display: 'flex', flexWrap: 'wrap', marginTop: 8 }}
              value={allocation}
              onChange={(event) => setAllocation(event.target.value)}
            >
              <Radio value="warehouse">按仓库（当前是{ALLOCATION_LABEL[warehouseAllocation]}）</Radio>
              <Radio value="strict">严格桶</Radio>
              <Radio value="fifo">先进先出</Radio>
              <Radio value="fefo">先到期先出</Radio>
            </Radio.Group>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 12 }}>
              <div>
                <Typography.Text strong>指定过的批次</Typography.Text>
                <Radio.Group
                  style={{ display: 'block', marginTop: 8 }}
                  value={batchConstraint}
                  onChange={(event) => setBatchConstraint(event.target.value)}
                >
                  <Radio value="prefer">建议</Radio>
                  <Radio value="lock">锁定</Radio>
                </Radio.Group>
              </div>
              <div>
                <Typography.Text strong>指定过的库位</Typography.Text>
                <Radio.Group
                  style={{ display: 'block', marginTop: 8 }}
                  value={locationConstraint}
                  onChange={(event) => setLocationConstraint(event.target.value)}
                >
                  <Radio value="prefer">建议</Radio>
                  <Radio value="lock">锁定</Radio>
                </Radio.Group>
              </div>
            </div>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 8 }}>
              没填的批次和库位不受这两项限制。建议可以改拣，锁定就不能换。
            </Typography.Paragraph>
          </div>
        ) : null}
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          {inbound
            ? '库位是这行货收进来放的位置，空着就是默认库位。批次空着就是默认批次。写了效期以后，同一种货的同一批次要保持同一个日期。同一商品可以分多行，只要库位或批次不同。'
            : `下拉里能看到可用量。库位是这行从哪出。下面列出每一桶，点「用这桶」填上库位和批次。${serialOn ? '按序列号的商品要自己写批次，这种商品不能按规则拆开。' : ''}${blockExpired ? '仓库开了过期拦截，过期批次不会被拿来扣。' : ''}`}
        </Typography.Paragraph>
        <Table<LineDraft>
          size="middle"
          rowKey="key"
          pagination={false}
          dataSource={lines}
          columns={columns}
          scroll={{ x: serialOn ? 1280 : 1100 }}
          onRow={(line) => ({ onClick: () => line.skuCode && setFocusKey(line.key) })}
        />
        {!inbound && focused ? (
          <StockBuckets
            line={focused}
            sku={skuRows.find((item) => item.skuCode === focused.skuCode)}
            stock={stockRows.find((row) => row.skuCode === focused.skuCode)}
            buckets={bucketRows.filter((row) => row.skuCode === focused.skuCode)}
            demand={kept
              .filter((row) => row.skuCode === focused.skuCode)
              .reduce((sum, row) => sum + (row.quantity || 0), 0)}
            onUse={(bucket) => {
              patchLine(setLines, focused.key, {
                locationCode: bucket.locationCode,
                batchNo: bucket.batchNo && bucket.batchNo !== 'DEFAULT' ? bucket.batchNo : '',
              });
            }}
          />
        ) : null}
      </Card>
    </div>
  );
}

function StockBuckets({
  line,
  sku,
  stock,
  buckets,
  demand,
  onUse,
}: {
  line: LineDraft;
  sku: Sku | undefined;
  stock: InventoryRow | undefined;
  buckets: InventoryBucketRow[];
  demand: number;
  onUse: (bucket: InventoryBucketRow) => void;
}) {
  const unit = stock?.unit ?? sku?.unit;
  const available = stock?.available ?? 0;
  const sorted = [...buckets].sort(
    (a, b) => a.locationCode.localeCompare(b.locationCode) || a.batchNo.localeCompare(b.batchNo),
  );
  return (
    <div style={{ marginTop: 16 }}>
      <Typography.Text strong>{sku ? `${sku.skuCode} · ${sku.name}` : line.skuCode} 的库存</Typography.Text>
      <div style={{ fontSize: 13, lineHeight: 1.7, marginTop: 4 }}>
        {stock ? (
          <>
            在库 {fmtQty(stock.quantity, unit)}
            {stock.held > 0 ? `，冻结 ${fmtQty(stock.held, unit)}` : ''}
            {(stock.reserved ?? 0) > 0 ? `，拣货占用 ${fmtQty(stock.reserved ?? 0, unit)}` : ''}
            ，可用 {fmtQty(available, unit)}。本单这个商品合计要出 {fmtQty(demand, unit)}。
          </>
        ) : (
          '还没有库存记录。可用按 0 看。'
        )}
        {demand > available ? ' 合计已经超过可用。' : ''}
      </div>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
        可用是整件商品扣掉冻结和拣货占用之后还能出的量。下面每一行是某个库位、某个批次上的实物数量。
      </Typography.Paragraph>
      {sorted.length === 0 ? (
        <Typography.Text type="secondary">没有还剩货的库位和批次。</Typography.Text>
      ) : (
        <Table<InventoryBucketRow>
          size="small"
          pagination={false}
          rowKey={(row) => `${row.locationCode}#${row.batchNo}`}
          dataSource={sorted}
          columns={[
            {
              title: '库位',
              dataIndex: 'locationCode',
              render: (value: string) => (value === 'DEFAULT' ? '默认库位' : value),
            },
            {
              title: '批次',
              dataIndex: 'batchNo',
              render: (value: string) => (!value || value === 'DEFAULT' ? '默认批次' : value),
            },
            {
              title: '效期',
              dataIndex: 'batchExpiryDate',
              render: (value: string | null) => value ?? '—',
            },
            {
              title: '实物',
              dataIndex: 'quantity',
              align: 'right',
              render: (value: number) => fmtQty(value, unit),
            },
            {
              title: '',
              render: (_value, bucket) => (
                <span>
                  {line.quantity > bucket.quantity ? (
                    <Typography.Text type="warning" style={{ marginRight: 8 }}>
                      不够这一行
                    </Typography.Text>
                  ) : null}
                  <Button size="small" onClick={() => onUse(bucket)}>
                    用这桶
                  </Button>
                </span>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}

function outboundSkuLabel(sku: Sku, stockRows: InventoryRow[]): string {
  const stock = stockRows.find((row) => row.skuCode === sku.skuCode);
  if (!stock) return `${sku.skuCode} · ${sku.name} · 无库存`;
  return `${sku.skuCode} · ${sku.name} · 可用 ${fmtQty(stock.available, stock.unit)}`;
}

function Choice({
  active,
  title,
  detail,
  onClick,
}: {
  active: boolean;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        flex: '1 1 240px',
        textAlign: 'left',
        padding: '14px 16px',
        borderRadius: 8,
        border: `1px solid ${active ? '#1677ff' : '#d9d9d9'}`,
        background: active ? '#e6f4ff' : '#fff',
        cursor: 'pointer',
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 15 }}>{title}</div>
      <div style={{ color: 'rgba(0,0,0,0.65)', fontSize: 13, marginTop: 4, lineHeight: 1.5 }}>{detail}</div>
    </button>
  );
}

function PartnerFacts({
  partner,
}: {
  partner: { name: string; contact: string | null; phone: string | null; address: string | null; note: string | null };
}) {
  const rows = [
    partner.contact ? `联系人 ${partner.contact}` : '',
    partner.phone ? `电话 ${partner.phone}` : '',
    partner.address ? `地址 ${partner.address}` : '',
    partner.note ? partner.note : '',
  ].filter((row) => row.length > 0);
  return (
    <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.7 }}>
      {rows.length > 0 ? (
        rows.map((row) => <div key={row}>{row}</div>)
      ) : (
        <Typography.Text type="secondary">这家单位的档案里还没有联系人、电话和地址。</Typography.Text>
      )}
    </div>
  );
}

function AvailableCell({ line, stock }: { line: LineDraft; stock: InventoryRow | undefined }) {
  if (!line.skuCode) return <Typography.Text type="secondary">—</Typography.Text>;
  if (!stock) return <Typography.Text type="secondary">没有库存记录</Typography.Text>;
  const reserved = stock.reserved ?? 0;
  return (
    <div style={{ fontSize: 12, lineHeight: 1.5 }}>
      <div>可用 {fmtQty(stock.available, stock.unit)}</div>
      <Typography.Text type="secondary">
        在库 {fmtQty(stock.quantity, stock.unit)}
        {stock.held > 0 ? `，冻结 ${fmtQty(stock.held, stock.unit)}` : ''}
        {reserved > 0 ? `，拣货占用 ${fmtQty(reserved, stock.unit)}` : ''}
      </Typography.Text>
      {line.quantity > stock.available ? (
        <div>
          <Typography.Text type="warning">超过当前可用</Typography.Text>
        </div>
      ) : null}
    </div>
  );
}

function patchLine(
  setLines: (value: LineDraft[] | ((prev: LineDraft[]) => LineDraft[])) => void,
  key: string,
  patch: Partial<LineDraft>,
) {
  setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
}

function toPayloadLine(line: LineDraft, direction: Direction, serialOn: boolean) {
  const serials = splitSerials(line.serialsText);
  return {
    skuCode: line.skuCode,
    quantity: line.quantity,
    ...(line.locationCode && line.locationCode !== 'DEFAULT' ? { locationCode: line.locationCode } : {}),
    ...(line.batchNo.trim() ? { batchNo: line.batchNo.trim() } : {}),
    ...(direction === 'in' && line.batchExpiryDate.trim() ? { batchExpiryDate: line.batchExpiryDate.trim() } : {}),
    ...(serialOn && serials.length > 0 ? { serials } : {}),
  };
}

function collectProblems(input: {
  lines: LineDraft[];
  skus: Sku[];
  direction: Direction;
  asn: boolean;
  expectedAt: string;
  serialOn: boolean;
  allocation: 'strict' | 'fifo' | 'fefo';
}): string[] {
  const problems: string[] = [];
  if (input.lines.length === 0) problems.push('至少留一行商品');
  const effective = input.allocation;
  const seen = new Set<string>();
  input.lines.forEach((line, index) => {
    const n = index + 1;
    if (!(line.quantity > 0)) problems.push(`第 ${n} 行数量要大于 0`);
    const sku = input.skus.find((item) => item.skuCode === line.skuCode);
    const serials = splitSerials(line.serialsText);
    if (input.serialOn && sku?.serialTracked) {
      if (serials.length === 0) problems.push(`第 ${n} 行 ${line.skuCode} 按序列号管理，要填写序列号`);
      else if (!Number.isInteger(line.quantity) || serials.length !== line.quantity) {
        problems.push(`第 ${n} 行 ${line.skuCode} 的序列号个数要和数量一致，数量要是整数`);
      }
      if (input.direction === 'out' && effective !== 'strict' && !line.batchNo.trim()) {
        problems.push(`第 ${n} 行 ${line.skuCode} 按序列号管理，出库要写明批次`);
      }
    } else if (serials.length > 0 && input.serialOn) {
      problems.push(`第 ${n} 行 ${line.skuCode} 不按序列号管理，请清空序列号`);
    }
    if (input.direction === 'in' && line.batchExpiryDate.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(line.batchExpiryDate.trim())) {
      problems.push(`第 ${n} 行效期请用 YYYY-MM-DD`);
    }
    const batchKey = line.batchNo.trim() || 'DEFAULT';
    const key = `${line.skuCode}@${line.locationCode || 'DEFAULT'}@${batchKey}`;
    if (seen.has(key)) problems.push(`第 ${n} 行与前面的商品、库位、批次重复，请合并数量`);
    seen.add(key);
  });
  if (input.asn && input.expectedAt.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(input.expectedAt.trim())) {
    problems.push('预计到货日请用 YYYY-MM-DD');
  }
  return problems;
}
