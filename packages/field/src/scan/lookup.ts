import { FieldApiError } from '../errors.js';
import { requestUrl } from '../url.js';

export interface FieldSkuHit {
  skuCode: string;
  name: string;
  barcode: string | null;
  status?: string;
  serialTracked: boolean;
}

export interface FieldLocationHit {
  locationCode: string;
  name: string;
  warehouseCode: string | null;
  warehouseName: string | null;
  zoneCode: string | null;
  zoneName: string | null;
  zoneKind: string | null;
  zoneKindLabel: string | null;
  capacity?: number;
}

/** 精确查询必须是长度 1 的裸数组。分页对象 { rows } 不算命中。 */
export function readExactRow(body: unknown): unknown | null {
  if (!Array.isArray(body) || body.length !== 1) return null;
  return body[0];
}

function asSku(row: unknown): FieldSkuHit | null {
  if (!row || typeof row !== 'object') return null;
  const rec = row as Record<string, unknown>;
  if (typeof rec.skuCode !== 'string' || typeof rec.name !== 'string') return null;
  const hit: FieldSkuHit = {
    skuCode: rec.skuCode,
    name: rec.name,
    barcode: typeof rec.barcode === 'string' ? rec.barcode : null,
    serialTracked: rec.serialTracked === true,
  };
  if (typeof rec.status === 'string') hit.status = rec.status;
  return hit;
}

function asLocation(row: unknown): FieldLocationHit | null {
  if (!row || typeof row !== 'object') return null;
  const rec = row as Record<string, unknown>;
  if (typeof rec.locationCode !== 'string') return null;
  const hit: FieldLocationHit = {
    locationCode: rec.locationCode,
    name: typeof rec.name === 'string' ? rec.name : '',
    warehouseCode: typeof rec.warehouseCode === 'string' ? rec.warehouseCode : null,
    warehouseName: typeof rec.warehouseName === 'string' ? rec.warehouseName : null,
    zoneCode: typeof rec.zoneCode === 'string' ? rec.zoneCode : null,
    zoneName: typeof rec.zoneName === 'string' ? rec.zoneName : null,
    zoneKind: typeof rec.zoneKind === 'string' ? rec.zoneKind : null,
    zoneKindLabel: typeof rec.zoneKindLabel === 'string' ? rec.zoneKindLabel : null,
  };
  if (typeof rec.capacity === 'number') hit.capacity = rec.capacity;
  return hit;
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch {
    throw new FieldApiError('FIELD_OFFLINE', '没发出去，看完再试', 0);
  }
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const record = body && typeof body === 'object' ? (body as { code?: unknown; message?: unknown }) : {};
    const code = typeof record.code === 'string' ? record.code : 'FIELD_HTTP';
    const message = typeof record.message === 'string' ? record.message : '没发出去，看完再试';
    throw new FieldApiError(code, message, res.status);
  }
  return body;
}

/** 先条码，再编码。两步都未命中是 null。空字符串不发请求。 */
export async function lookupSku(
  baseUrl: string,
  raw: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FieldSkuHit | null> {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const encoded = encodeURIComponent(trimmed);
  const byBarcode = asSku(readExactRow(await getJson(fetchImpl, requestUrl(baseUrl, `/api/skus?barcode=${encoded}`))));
  if (byBarcode) return byBarcode;
  return asSku(readExactRow(await getJson(fetchImpl, requestUrl(baseUrl, `/api/skus?skuCode=${encoded}`))));
}

/** 只认库位编码，不拿名称或模糊 q 去猜。 */
export async function lookupLocation(
  baseUrl: string,
  raw: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FieldLocationHit | null> {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const body = await getJson(fetchImpl, requestUrl(baseUrl, `/api/locations?code=${encodeURIComponent(trimmed)}`));
  return asLocation(readExactRow(body));
}
