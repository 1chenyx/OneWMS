import type { ModuleManifest } from '@one/core';
import { ORDER_ASN_FIELD, extraRecord } from './builtin-records.js';

/**
 * module.asn —— 到货预报。
 *
 * 向既有 inbound 流程贡献状态，不新建流程。
 * created→announced 挂 when：停用后不能再把单据改成预报。
 * announced→received 加库存，announced→canceled 不动库存。这两条不挂 when，
 * 已经预报的单停用后仍可收货或取消。
 * 建单带 asn 时直接落在 announced。直接入库仍是 created→received。
 */
export function asnManifest(): ModuleManifest {
  return {
    id: 'module.asn',
    name: '到货预报',
    description:
      '入库前的到货预报。货还没到时开一张预报单（状态为已预报，可选预计到货日），到货后再收货，收货时才加库存。取消预报不动库存。停用本模块后不能再开新的预报单；已经预报的仍可收货或取消。不开预报时，入库仍是创建后直接收货。',
    version: '0.1.0',
    capabilities: ['db.read', 'events.subscribe'],
    dependencies: { modules: ['core.wms'] },
    aliases: ['预报', 'asn'],
    records: [extraRecord('order', '单据', [ORDER_ASN_FIELD])],
    workflows: {
      contributes: {
        inbound: {
          states: [{ id: 'announced', label: '已预报' }],
          transitions: [
            { from: 'created', to: 'announced', when: 'module.asn.enabled', effect: 'none' },
            { from: 'announced', to: 'received', effect: 'increase' },
            { from: 'announced', to: 'canceled', effect: 'none' },
          ],
        },
      },
    },
  };
}
