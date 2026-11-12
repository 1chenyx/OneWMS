import { useState } from 'react';
import { orderNumberPlace } from '@one/wms/numbering';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Input, InputNumber, Select, Table, Typography } from 'antd';
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
import { useDraftNumber } from '../components/use-seeded-code';
import ScanInput from '../components/ScanInput';
import { fmtQty } from '../lib/format';
import { monoCell, numCell } from '../components/table-style';
import { readAllocation } from './use-outbound-rules';

/**
 * 新建入库单或出库单。方向由所在页面定死，这一页不再切换。
 * 出库选商品时摊开每一桶的库位、批次、效期和数量。点「用这桶」填上库位和批次。
 * 出库行的库位和批次只展示不给改，换桶就是改这两格；入库行才自己写库位、批次和效期。
 * 批次怎么扣、写了的批次和库位能不能换，在规则页配置。这张单只提示当前规则，不再另选。
 * 提交走 wms.order.create。单号按规则预先填好，可以改；留空则保存时再生成。这一步不改库存。
 * 出库在保存时按所选桶的实物和商品可用量预检，不够就报错、不建单。服务端再按同样的桶复核。
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
  const inbound = direction === 'in';
  const orderNoDraft = useDraftNumber(orderNumberPlace({ direction, asn: inbound && asn }));
  const [partnerCode, setPartnerCode] = useState('');
  const [note, setNote] = useState('');
  const [expectedAt, setExpectedAt] = useState('');
  const [lines, setLines] = useState<LineDraft[]>(() => [blankLine()]);
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const modules = snapshot.data?.modules;
  const asnOn = modules?.['module.asn']?.enabled === true;
  const serialOn = modules?.['module.serial']?.enabled === true;
  const reservationOn = modules?.['module.reservation']?.enabled === true;
  const wmsSettings = modules?.['core.wms']?.settings;
  const warehouseAllocation = readAllocation(wmsSettings);
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
    allocation: inbound ? 'strict' : warehouseAllocation,
    buckets: bucketRows,
    stock: stockRows,
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
      const first = problems[0] ?? '';
      if (first.includes('不够出') || first.includes('可用只有')) message.error(first);
      else message.warning(first);
      return;
    }
    const orderNo = orderNoDraft.value.trim();
    const body = {
      direction,
      lines: kept.map((line) => toPayloadLine(line, direction, serialOn)),
      ...(orderNo ? { orderNo } : {}),
      ...(partnerCode ? { partnerCode } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(inbound && asn ? { asn: true as const, ...(expectedAt.trim() ? { expectedAt: expectedAt.trim() } : {}) } : {}),
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
      render: (_value, line) => (
        <Select
          showSearch
          optionFilterProp="label"
          placeholder="选择商品"
          style={{ width: '100%', minWidth: 220 }}
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
      onCell: numCell,
      render: (_value, line) => {
        const sku = skuRows.find((item) => item.skuCode === line.skuCode);
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <InputNumber
              min={0.001}
              precision={3}
              value={line.quantity}
              style={{ flex: 1, minWidth: 100 }}
              onChange={(value) => patchLine(setLines, line.key, { quantity: typeof value === 'number' ? value : 0 })}
            />
            {sku?.unit ? <span>{sku.unit}</span> : null}
          </div>
        );
      },
    },
    {
      title: '库位',
      render: (_value, line) =>
        inbound ? (
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: '100%' }}
            value={line.locationCode}
            onChange={(value) => patchLine(setLines, line.key, { locationCode: value })}
            options={locationOptions}
          />
        ) : (
          <span>{locationLabel(line.locationCode, locationRows)}</span>
        ),
    },
    {
      title: '批次',
      onCell: monoCell,
      render: (_value, line) =>
        inbound ? (
          <Input
            placeholder="空 = 默认批次"
            value={line.batchNo}
            onChange={(e) => patchLine(setLines, line.key, { batchNo: e.target.value })}
          />
        ) : line.batchNo.trim() ? (
          <span>{line.batchNo}</span>
        ) : (
          <Typography.Text type="secondary">默认批次</Typography.Text>
        ),
    },
    ...(inbound
      ? [
          {
            title: '效期',
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
            render: (_value: unknown, line: LineDraft) => (
              <AvailableCell line={line} stock={stockRows.find((row) => row.skuCode === line.skuCode)} />
            ),
          } satisfies ColumnsType<LineDraft>[number],
        ]),
    ...(serialOn
      ? [
          {
            title: '序列号',
            render: (_value: unknown, line: LineDraft) => (
              <Input.TextArea
                rows={2}
                placeholder="每行一个，或用逗号、空格分开"
                style={{ minWidth: 180 }}
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
      ? '单号已按预报规则填好，可以改。留空则保存时再生成。这是到货预报，收到货再收货，那时才加库存。'
      : '单号已按入库规则填好，可以改。留空则保存时再生成。保存后待收货，收货才加库存。'
    : reservationOn
      ? '单号已按出库规则填好，可以改。留空则保存时再生成。保存后待拣货，拣货占用可用量，发货才扣库存。'
      : '单号已按出库规则填好，可以改。留空则保存时再生成。保存后待发货，发货才扣库存。';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0, height: '100%' }}>
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
      <Card title="单据" style={{ flex: 'none' }}>
        {/* 单号、往来单位、备注横排一行，把纵向高度让给下面的明细 */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 220px', minWidth: 200 }}>
            <Typography.Text strong>单号</Typography.Text>
            <Input
              aria-label="单号"
              style={{ marginTop: 4 }}
              placeholder="留空则按编号规则生成"
              value={orderNoDraft.value}
              onChange={(event) => orderNoDraft.onChange(event.target.value)}
            />
          </div>
          <div style={{ flex: '1 1 240px', minWidth: 220 }}>
            <Typography.Text strong>{inbound ? '供应商' : '客户'}</Typography.Text>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: '100%', marginTop: 4 }}
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
          </div>
          <div style={{ flex: '2 1 320px', minWidth: 260 }}>
            <Typography.Text strong>备注</Typography.Text>
            <Input.TextArea
              style={{ marginTop: 4 }}
              autoSize={{ minRows: 1, maxRows: 3 }}
              placeholder={inbound ? '例如采购单号、到货说明' : '例如客户订单号、发货要求'}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        {partner ? <PartnerFacts partner={partner} /> : null}
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
      </Card>

      <Card
        title="明细"
        style={{ flex: 1, minHeight: 260, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        styles={{ body: { flex: 1, minHeight: 0, padding: 0, display: 'flex', flexDirection: 'column' } }}
      >
        {/* 扫码条固定在明细卡顶部，明细行在它下面滚 */}
        <div style={{ flex: 'none', padding: '16px 24px 12px' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
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
        </div>
        {/* 滚动收在明细区里：表头吸顶、横向滚动条吸底，页面外层不再出滚动条 */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 24px 24px' }}>
          <Table<LineDraft>
            size="middle"
            rowKey="key"
            pagination={false}
            dataSource={lines}
            columns={columns}
            scroll={{ x: 'max-content' }}
            sticky
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
        </div>
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

/** 出库行的库位只给看，要换库位就在下面点另一桶。 */
function locationLabel(code: string, rows: Location[]): string {
  if (!code || code === 'DEFAULT') return '默认库位';
  const found = rows.find((row) => row.locationCode === code);
  return found ? `${found.locationCode} · ${found.name}` : code;
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
        padding: '12px 16px',
        borderRadius: 8,
        border: '1px solid rgba(23, 23, 23, 0.14)',
        background: active ? '#f4f4f5' : '#fff',
        boxShadow: active ? 'inset 3px 0 0 #e6b325' : 'none',
        fontWeight: 500,
        cursor: 'pointer',
      }}
    >
      <div style={{ fontWeight: 500, fontSize: 15 }}>{title}</div>
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
  buckets: InventoryBucketRow[];
  stock: InventoryRow[];
}): string[] {
  const problems: string[] = [];
  if (input.lines.length === 0) problems.push('至少留一行商品');
  const effective = input.allocation;
  const seen = new Set<string>();
  const demand = new Map<string, number>();
  input.lines.forEach((line, index) => {
    const n = index + 1;
    if (!(line.quantity > 0)) problems.push(`第 ${n} 行数量要大于 0`);
    else if (input.direction === 'out' && line.skuCode) {
      demand.set(line.skuCode, (demand.get(line.skuCode) ?? 0) + line.quantity);
      const namedBatch = line.batchNo.trim();
      if (namedBatch || effective === 'strict') {
        const locationCode = line.locationCode || 'DEFAULT';
        const batchNo = namedBatch || 'DEFAULT';
        const bucket = input.buckets.find(
          (row) =>
            row.skuCode === line.skuCode &&
            row.locationCode === locationCode &&
            (row.batchNo || 'DEFAULT') === batchNo,
        );
        const onHand = bucket?.quantity ?? 0;
        if (line.quantity > onHand) {
          problems.push(`第 ${n} 行 ${line.skuCode} 这一桶只有 ${fmtQty(onHand)}，不够出 ${fmtQty(line.quantity)}`);
        }
      }
    }
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
  if (input.direction === 'out') {
    for (const [skuCode, quantity] of demand) {
      const available = input.stock.find((row) => row.skuCode === skuCode)?.available ?? 0;
      if (quantity > available) problems.push(`${skuCode} 合计要出 ${fmtQty(quantity)}，可用只有 ${fmtQty(available)}`);
    }
  }
  if (input.asn && input.expectedAt.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(input.expectedAt.trim())) {
    problems.push('预计到货日请用 YYYY-MM-DD');
  }
  return problems;
}
