/**
 * 对接鉴权。这一版真正收发的是 Bearer、API Key、Basic。
 * hmac 和 oauth 配置能通过校验，但运行时拒绝，不会裸发。
 * 比对走摘要，日志和错误信息不带密钥。
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Connector } from './types.js';

export interface SecretReader {
  get(connectorId: string, name: string): string | undefined;
}

export type AuthHeaders =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; message: string };

const UNSUPPORTED = new Set(['hmac-sha256', 'oauth2-client']);

/** 出站要加的头。none 不加头。密钥缺失或还没接通的适配器不会给出头。 */
export function outboundAuthHeaders(connector: Connector, secrets: SecretReader): AuthHeaders {
  const adapter = connector.auth.adapter;
  if (adapter === 'none') return { ok: true, headers: {} };
  if (UNSUPPORTED.has(adapter)) return { ok: false, message: `${adapter} 还没接通，没有发出请求` };
  return buildHeaders(connector, secrets);
}

/** 入站必须对上密钥。none、还没接通的适配器、密钥不对，都是没有通过。 */
export function checkInboundAuth(
  connector: Connector,
  headers: Record<string, string | undefined>,
  secrets: SecretReader,
): { ok: true } | { ok: false; message: string } {
  const adapter = connector.auth.adapter;
  if (UNSUPPORTED.has(adapter)) return { ok: false, message: '这一档鉴权还没接通' };
  if (adapter === 'none') return { ok: false, message: '鉴权没有通过' };
  const built = buildHeaders(connector, secrets);
  if (!built.ok || Object.keys(built.headers).length === 0) return { ok: false, message: '鉴权没有通过' };
  for (const [name, expected] of Object.entries(built.headers)) {
    const got = readHeader(headers, name);
    if (got === undefined || !same(got, expected)) return { ok: false, message: '鉴权没有通过' };
  }
  return { ok: true };
}

function buildHeaders(connector: Connector, secrets: SecretReader): AuthHeaders {
  const refs = connector.auth.secretRefs ?? {};
  const read = (slot: string): string | undefined => {
    const name = refs[slot];
    if (!name) return undefined;
    const value = secrets.get(connector.id, name);
    if (typeof value !== 'string' || value === '' || /[\r\n\u0000]/.test(value)) return undefined;
    return value;
  };

  if (connector.auth.adapter === 'bearer') {
    const token = read('token');
    if (!token) return { ok: false, message: '密钥还没写入本机密钥库' };
    return { ok: true, headers: { authorization: `Bearer ${token}` } };
  }

  if (connector.auth.adapter === 'apiKey') {
    const key = read('key');
    const placement = connector.auth.placement;
    if (!key || !placement) return { ok: false, message: '密钥还没写入本机密钥库' };
    const prefix = placement.prefix ?? '';
    if (/[\r\n\u0000]/.test(prefix)) return { ok: false, message: '密钥还没写入本机密钥库' };
    return { ok: true, headers: { [placement.header.toLowerCase()]: `${prefix}${key}` } };
  }

  if (connector.auth.adapter === 'basic') {
    const username = read('username');
    const password = read('password');
    if (!username || !password) return { ok: false, message: '密钥还没写入本机密钥库' };
    const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
    return { ok: true, headers: { authorization: `Basic ${encoded}` } };
  }

  return { ok: false, message: '鉴权没有通过' };
}

function readHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && value !== undefined) return value;
  }
  return undefined;
}

function same(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest();
  const b = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(a, b);
}
