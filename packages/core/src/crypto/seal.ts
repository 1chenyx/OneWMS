import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { CryptoError } from '../errors.js';
import type { EventEnvelope } from '../oplog/envelope.js';

/**
 * 事件密封纯函数层（DESIGN §8.5 传输安全，里程碑 7）。
 *
 * 「信封明文供路由，中继只见密文」：信封字段（workspaceId/actor/seq/lamport/
 * eventId/type/createdAt）保留明文——路由、水位握手、幂等去重所需；
 * payload 以 AES-256-GCM 加密（随机 nonce + 认证标签）。
 *
 * 本文件无状态无 IO：密钥由调用方持有（KeyService 管理，工作区密钥）。
 */

/** 密封后的事件形态：信封明文 + 密文 payload（跨不可信传输的载荷单元） */
export interface SealedEvent {
  /** 以下全部为 EventEnvelope 的明文照抄（路由/水位/幂等所需） */
  readonly eventId: string;
  readonly workspaceId: string;
  readonly actor: string;
  readonly lamport: number;
  readonly seq: number;
  readonly type: string;
  readonly createdAt: string;
  /** AES-256-GCM 密文（base64，末 16 字节为认证标签） */
  readonly cipher: string;
  /** 随机 nonce（base64，12 字节）——同事件两次密封密文不同 */
  readonly nonce: string;
}

/** 工作区密钥的规范形态：32 字节 AES-256 密钥的 hex（64 字符） */
export function isValidKeyHex(keyHex: string): boolean {
  return /^[0-9a-f]{64}$/.test(keyHex);
}

/** 校验并解析密钥（非法格式 → CryptoError） */
function parseKey(keyHex: string): Buffer {
  if (!isValidKeyHex(keyHex)) {
    throw new CryptoError('工作区密钥必须是 64 位 hex（256-bit）字符串');
  }
  return Buffer.from(keyHex, 'hex');
}

/** 密钥指纹：sha256 前 8 位 hex——供两台设备上人工比对「我们拿的是同一把钥匙」 */
export function keyFingerprint(keyHex: string): string {
  return createHash('sha256').update(keyHex, 'hex').digest('hex').slice(0, 8);
}

/** 密封一条事件（payload 加密，信封明文照抄） */
export function sealEnvelope(env: EventEnvelope, keyHex: string): SealedEvent {
  const key = parseKey(keyHex);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(env.payload ?? null), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    eventId: env.eventId,
    workspaceId: env.workspaceId,
    actor: env.actor,
    lamport: env.lamport,
    seq: env.seq,
    type: env.type,
    createdAt: env.createdAt,
    cipher: encrypted.toString('base64'),
    nonce: nonce.toString('base64'),
  };
}

/** 解封一条密文事件（密钥不符或密文被篡改 → CryptoError，绝不静默给错数据） */
export function unsealEnvelope(sealed: SealedEvent, keyHex: string): EventEnvelope {
  const key = parseKey(keyHex);
  let data: Buffer;
  try {
    const raw = Buffer.from(sealed.cipher, 'base64');
    const nonce = Buffer.from(sealed.nonce, 'base64');
    if (raw.length < 16 || nonce.length !== 12) {
      throw new CryptoError('密文结构非法');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    data = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]);
  } catch (err) {
    if (err instanceof CryptoError) throw err;
    // GCM 认证失败（密钥不一致/密文被篡改）落在这里
    throw new CryptoError(
      `解密失败（密钥不一致或密文被篡改，事件 ${sealed.eventId}）: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    eventId: sealed.eventId,
    workspaceId: sealed.workspaceId,
    actor: sealed.actor,
    lamport: sealed.lamport,
    seq: sealed.seq,
    type: sealed.type,
    payload: JSON.parse(data.toString('utf8')),
    createdAt: sealed.createdAt,
  };
}
