import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCancelWave, useCreateWave, useOrders, usePickWave, useProfileSnapshot, useWave, useWaves } from '../api/hooks';
import { ApiError } from '../api/client';
import type { Order, WaveSummary, WaveWalkLine } from '../api/client';
import PageHeader from '../components/PageHeader';
import { monoCell, TABLE_PAGINATION } from '../components/table-style';
import { useAppNav } from '../app-nav';
import { fmtQty } from '../lib/format';

const WAVE_STATE: Record<string, { text: string; color?: string }> = {
  open: { text: '待拣', color: 'processing' },
  picking: { text: '已放拣货', color: 'green' },
  canceled: { text: '已取消' },
};

const ORDER_STATE: Record<string, string> = {
  created: '已创建',
  waved: '已组波',
  picking: '拣货中',
  picked: '已拣货',
  reviewed: '已复核',
  packed: '已打包',
  loaded: '已装车',
  shipped: '已发货',
  done: '完成',
  canceled: '已取消',
};

function placeLabel(code: string | undefined): string {
  return !code || code === 'DEFAULT' ? '默认库位' : code;
}

function batchLabel(code: string): string {
  return !code || code === 'DEFAULT' ? '未指定批次' : code;
}

/**
 * 波次页：把多张已创建的出库单收成一波。
 * 清单按库位加总，拣货员走一趟。拣货开着时，整波生成一张拣货单。
 */
export default function WavePage() {
  const { message, modal } = AntApp.useApp();
  const { navigate, takeInitialFilter } = useAppNav();
  const [hinted] = useState(() => takeInitialFilter()?.orderNo ?? '');
  const snapshot = useProfileSnapshot();
  const off = snapshot.data?.modules['module.wave']?.enabled === false;
  const pickingOn = snapshot.data?.modules['module.picking']?.enabled === true;
  const { data: orders, isLoading: ordersLoading } = useOrders('out');
  const { data: waves, isLoading: wavesLoading } = useWaves();
  const create = useCreateWave();
  const pick = usePickWave();
  const cancel = useCancelWave();
  const [checked, setChecked] = useState<string[]>([]);
  const [selectedWave, setSelectedWave] = useState<string | null>(null);
  const detail = useWave(selectedWave);
  const appliedHint = useRef(false);

  const taken = useMemo(() => {
    const nos = new Set<string>();
    for (const wave of waves ?? []) {
      if (wave.state === 'canceled') continue;
      for (const orderNo of wave.orderNos) nos.add(orderNo);
    }
    return nos;
  }, [waves]);

  const waiting = useMemo(
    () => (Array.isArray(orders) ? orders : []).filter((order) => order.state === 'created' && !taken.has(order.orderNo)),
    [orders, taken],
  );

  useEffect(() => {
    if (appliedHint.current || !hinted || !waves) return;
    appliedHint.current = true;
    const host = waves.find((wave) => wave.state !== 'canceled' && wave.orderNos.includes(hinted));
    if (host) {
      setSelectedWave(host.waveNo);
      return;
    }
    setChecked((prev) => (prev.includes(hinted) ? prev : [...prev, hinted]));
  }, [hinted, waves]);

  const submit = async () => {
    if (checked.length === 0) return;
    try {
      const created = await create.mutateAsync({ orderNos: checked });
      message.success(`已组成波次 ${created.waveNo}，共 ${created.orderNos.length} 张出库单`);
      setChecked([]);
      setSelectedWave(created.waveNo);
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : `组波失败：${String(error)}`);
    }
  };

  const release = (waveNo: string) => {
    modal.confirm({
      title: `按波次 ${waveNo} 拣货？`,
      content: '这一波的出库单会一起进入拣货中，并生成一张拣货单。库存按加总后的数量预检。',
      onOk: async () => {
        try {
          const released = await pick.mutateAsync(waveNo);
          message.success(`已生成拣货单 ${released.pickingNo}`);
          navigate('pickings', { pickingNo: released.pickingNo });
        } catch (error) {
          message.error(error instanceof ApiError ? error.message : `放行失败：${String(error)}`);
        }
      },
    });
  };

  const dismiss = (waveNo: string) => {
    modal.confirm({
      title: `取消波次 ${waveNo}？`,
      content: '还停在已组波的出库单会回到已创建，可以重新勾选组波。',
      onOk: async () => {
        try {
          await cancel.mutateAsync(waveNo);
          message.success(`已取消波次 ${waveNo}`);
        } catch (error) {
          message.error(error instanceof ApiError ? error.message : `取消失败：${String(error)}`);
        }
      },
    });
  };

  const waitingColumns: ColumnsType<Order> = [
    { title: '单号', dataIndex: 'orderNo', onCell: monoCell },
    {
      title: '明细',
      render: (_, order) =>
        order.lines.map((line) => `${line.skuCode} ${fmtQty(line.quantity, line.unit)} @ ${placeLabel(line.locationCode)}`).join('，'),
    },
    {
      title: '客户',
      dataIndex: 'partnerName',
      render: (value: string | null) => value || '—',
    },
  ];

  const waveColumns: ColumnsType<WaveSummary> = [
    { title: '波次号', dataIndex: 'waveNo', onCell: monoCell },
    { title: '单数', render: (_, wave) => wave.orderNos.length },
    {
      title: '状态',
      dataIndex: 'state',
      render: (value: string) => {
        const tag = WAVE_STATE[value] ?? { text: value };
        return <Tag color={tag.color}>{tag.text}</Tag>;
      },
    },
    {
      title: '出库单',
      render: (_, wave) => wave.orderNos.join('、'),
    },
    {
      title: '拣货单',
      dataIndex: 'pickingNo',
      onCell: monoCell,
      render: (value: string | null) => value || '—',
    },
  ];

  const walkColumns: ColumnsType<WaveWalkLine> = [
    { title: '库位', dataIndex: 'locationCode', render: (value: string) => placeLabel(value) },
    {
      title: '商品',
      render: (_, line) => `${line.skuCode} ${line.skuName}`.trim(),
    },
    { title: '批次', dataIndex: 'batchNo', render: (value: string) => batchLabel(value) },
    { title: '合计', render: (_, line) => fmtQty(line.quantity, line.unit) },
    {
      title: '来自',
      render: (_, line) => line.orders.map((part) => `${part.orderNo} ${fmtQty(part.quantity, line.unit)}`).join('、'),
    },
  ];

  const current = detail.data;
  const allWaved = current?.orders.every((order) => order.state === 'waved') === true;
  const canPick = pickingOn && current?.state === 'open' && allWaved;
  const canCancel =
    current?.state === 'open' &&
    current.orders.every((order) => order.state === 'waved' || order.state === 'canceled');

  return (
    <div className="app-fill list-page" style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      <PageHeader
        title="波次"
        subtitle="勾上要一起出的出库单，组成一个波次。下面按库位把数量加总，拣货员按这个顺序走一趟。"
      />
      {off ? (
        <Alert
          type="info"
          showIcon
          message="波次已关闭。新的出库单从建单直接拣货或发货。已经组好的波次仍可按整波拣货或取消。"
        />
      ) : null}
      <Card
        title="待组波"
        extra={
          <Button type="primary" disabled={off || checked.length === 0} loading={create.isPending} onClick={() => void submit()}>
            组成波次{checked.length > 0 ? `（${checked.length}）` : ''}
          </Button>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          一张单也可以单独成波。勾上多张时，同一库位的同一种货会加在一起拣。
        </Typography.Paragraph>
        <Table
          rowKey="orderNo"
          size="small"
          loading={ordersLoading || wavesLoading}
          dataSource={waiting}
          columns={waitingColumns}
          pagination={TABLE_PAGINATION}
          rowSelection={{
            selectedRowKeys: checked,
            onChange: (keys) => setChecked(keys.map(String)),
            getCheckboxProps: () => ({ disabled: off }),
          }}
          locale={{ emptyText: '没有待组波的出库单' }}
        />
      </Card>
      <Card title="波次">
        <Table
          rowKey="waveNo"
          size="small"
          loading={wavesLoading}
          dataSource={waves ?? []}
          columns={waveColumns}
          pagination={TABLE_PAGINATION}
          onRow={(wave) => ({
            onClick: () => setSelectedWave(wave.waveNo),
            style: { cursor: 'pointer', background: wave.waveNo === selectedWave ? 'rgba(22, 119, 255, 0.06)' : undefined },
          })}
          locale={{ emptyText: '还没有波次' }}
        />
      </Card>
      {selectedWave ? (
        <Card
          title={current ? `波次 ${current.waveNo}` : selectedWave}
          loading={detail.isLoading}
          extra={
            current ? (
              <span>
                {current.pickingNo ? (
                  <Button size="small" style={{ marginRight: 8 }} onClick={() => navigate('pickings', { pickingNo: current.pickingNo! })}>
                    打开拣货单
                  </Button>
                ) : null}
                {canPick ? (
                  <Button size="small" type="primary" style={{ marginRight: 8 }} loading={pick.isPending} onClick={() => release(current.waveNo)}>
                    按这波拣货
                  </Button>
                ) : null}
                {canCancel ? (
                  <Button size="small" danger loading={cancel.isPending} onClick={() => dismiss(current.waveNo)}>
                    取消波次
                  </Button>
                ) : null}
              </span>
            ) : null
          }
        >
          {current ? (
            <>
              <Typography.Paragraph type="secondary">
                拣货员按库位从上到下走。合计是这几张单加在一起的数量，来自一列写明每张单要多少。
                {pickingOn
                  ? '点「按这波拣货」会把这些单放进同一张拣货单。'
                  : '拣货关着。按这张清单拣完后，回各张出库单继续往后做。'}
              </Typography.Paragraph>
              <Table
                rowKey={(line) => `${line.locationCode}:${line.skuCode}:${line.batchNo}`}
                size="small"
                dataSource={current.walk}
                columns={walkColumns}
                pagination={false}
                locale={{ emptyText: '这一波没有还要拣的货' }}
              />
              <Typography.Title level={5}>出库单</Typography.Title>
              <Table
                rowKey="orderNo"
                size="small"
                pagination={false}
                dataSource={current.orders}
                columns={[
                  { title: '单号', dataIndex: 'orderNo', onCell: monoCell },
                  { title: '状态', dataIndex: 'state', render: (value: string) => ORDER_STATE[value] ?? value },
                  { title: '客户', dataIndex: 'partnerName', render: (value: string | null) => value || '—' },
                ]}
              />
            </>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
