import { Typography } from 'antd';
import type { Order, Picking } from '../api/client';
import { printTd, printTh } from './table-style';
import { fmtQty } from '../lib/format';

/** 出入库单纸张标题。弹窗标题和纸面抬头共用，避免两处文案漂移。 */
export function orderPrintTitle(order: Order): string {
  return `${order.direction === 'in' ? '入库单' : '出库单'} ${order.orderNo}`;
}

/** 拣货单纸张标题。 */
export function pickingPrintTitle(picking: Picking): string {
  return `拣货单 ${picking.pickingNo}`;
}

function pickingStateLabel(state: string): string {
  if (state === 'created') return '拣货中';
  if (state === 'closed') return '已关单';
  return '已取消';
}

/** 出入库单纸面。弹窗预览和打印根渲染同一份。 */
export function OrderPrintSheet({ order }: { order: Order }) {
  const inbound = order.direction === 'in';
  return (
    <div style={{ maxWidth: 720 }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        {orderPrintTitle(order)}
      </Typography.Title>
      <div style={{ fontSize: 12, color: '#444', marginBottom: 8 }}>
        创建时间：{order.createdAt.slice(0, 19).replace('T', ' ')}
        {order.returnOfOrderNo ? `　原单号：${order.returnOfOrderNo}` : ''}
        {order.expectedAt ? `　预计到货：${order.expectedAt}` : ''}
        {order.partnerName ? `　往来单位：${order.partnerName}` : ''}
        {order.note ? `　备注：${order.note}` : ''}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={printTh}>SKU</th>
            <th style={printTh}>名称</th>
            <th style={printTh}>数量</th>
            <th style={printTh}>批次</th>
            {inbound ? <th style={printTh}>效期</th> : null}
            <th style={printTh}>{inbound ? '目标库位' : '库位'}</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((l, i) => (
            <tr key={`${l.skuCode}#${i}`}>
              <td style={printTd}>{l.skuCode}</td>
              <td style={printTd}>{l.name}</td>
              <td style={{ ...printTd, textAlign: 'right' }}>{fmtQty(l.quantity, l.unit)}</td>
              <td style={printTd}>{l.batchNo ?? '-'}</td>
              {inbound ? <td style={printTd}>{l.batchExpiryDate ?? '-'}</td> : null}
              <td style={printTd}>{l.locationCode ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 32, fontSize: 12 }}>签收人签字：______________　　日期：______________</div>
    </div>
  );
}

/** 拣货单纸面。行按建议库位排序，和现场走动顺序一致。 */
export function PickingPrintSheet({ picking }: { picking: Picking }) {
  const lines = [...picking.lines].sort((a, b) =>
    (a.suggestedLocationCode ?? '').localeCompare(b.suggestedLocationCode ?? ''),
  );
  return (
    <div style={{ maxWidth: 720 }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        {pickingPrintTitle(picking)}
      </Typography.Title>
      <div style={{ fontSize: 12, color: '#444', marginBottom: 8 }}>
        关联出库单：{[...new Set(picking.lines.map((l) => l.orderNo))].join('、') || '-'}
        　创建时间：{picking.createdAt.slice(0, 19).replace('T', ' ')}
        　状态：{pickingStateLabel(picking.state)}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={printTh}>拣</th>
            <th style={printTh}>SKU</th>
            <th style={printTh}>名称</th>
            <th style={printTh}>建议库位</th>
            <th style={printTh}>建议批次</th>
            <th style={printTh}>应拣</th>
            <th style={printTh}>已拣</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <td style={printTd}>□</td>
              <td style={printTd}>{l.skuCode}</td>
              <td style={printTd}>{l.skuName}</td>
              <td style={printTd}>{l.suggestedLocationCode ?? '-'}</td>
              <td style={printTd}>{l.suggestedBatchNo ?? '-'}</td>
              <td style={{ ...printTd, textAlign: 'right' }}>{fmtQty(l.qtyToPick, l.unit)}</td>
              <td style={{ ...printTd, textAlign: 'right' }}>{fmtQty(l.pickedQty, l.unit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 32, fontSize: 12 }}>拣货人签字：______________　　日期：______________</div>
    </div>
  );
}
