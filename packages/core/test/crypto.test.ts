import { describe, it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  OneCore,
  CryptoError,
  KeyExistsError,
  sealEnvelope,
  unsealEnvelope,
  keyFingerprint,
  isValidKeyHex,
  buildEnvelope,
  type SealedEvent,
} from '../src/index.js';

/**
 * 加密与密钥测试（DESIGN §8.5 传输安全，里程碑 7）：
 *  - seal/unseal 纯函数：往返、错钥、篡改、nonce 随机性、指纹稳定；
 *  - KeyService：生成/导入/幂等拒绝/持久化（文件库重开仍在）。
 */

const WS = 'ws-crypto';
/** 两个合法但不同的 256-bit 密钥 */
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

function mkEnvelope(payload: unknown) {
  return buildEnvelope({ workspaceId: WS, actor: 'user:local@node-x', seq: 1, lamport: 1, type: 'wms.sku.created', payload });
}

describe('sealEnvelope / unsealEnvelope（纯函数）', () => {
  it('往返：中文/嵌套 payload 原样还原，信封字段明文照抄', () => {
    const payload = { 名称: '轴承-6204', nested: { lines: [{ qty: 3, note: '第一批' }] }, flag: null };
    const sealed = sealEnvelope(mkEnvelope(payload), KEY_A);
    expect(sealed.eventId).toBeTruthy();
    expect(sealed.actor).toBe('user:local@node-x');
    expect(sealed.type).toBe('wms.sku.created');
    const restored = unsealEnvelope(sealed, KEY_A);
    expect(restored.payload).toEqual(payload);
    expect(restored.eventId).toBe(sealed.eventId);
    expect(restored.seq).toBe(sealed.seq);
  });

  it('错钥解密 → CryptoError（绝不静默给错数据）', () => {
    const sealed = sealEnvelope(mkEnvelope({ a: 1 }), KEY_A);
    expect(() => unsealEnvelope(sealed, KEY_B)).toThrow(CryptoError);
  });

  it('密文被篡改 → CryptoError（GCM 认证标签）', () => {
    const sealed = sealEnvelope(mkEnvelope({ a: 1 }), KEY_A);
    const raw = Buffer.from(sealed.cipher, 'base64');
    raw[0] = raw[0]! ^ 0xff;
    const tampered: SealedEvent = { ...sealed, cipher: raw.toString('base64') };
    expect(() => unsealEnvelope(tampered, KEY_A)).toThrow(CryptoError);
  });

  it('nonce 随机：同事件两次密封 → 密文不同，均可解回', () => {
    const env = mkEnvelope({ x: 1 });
    const s1 = sealEnvelope(env, KEY_A);
    const s2 = sealEnvelope(env, KEY_A);
    expect(s1.nonce).not.toBe(s2.nonce);
    expect(s1.cipher).not.toBe(s2.cipher);
    expect(unsealEnvelope(s1, KEY_A).payload).toEqual(unsealEnvelope(s2, KEY_A).payload);
  });

  it('密钥格式非法 → CryptoError；keyFingerprint 稳定且随密钥变化', () => {
    expect(() => sealEnvelope(mkEnvelope({}), 'short')).toThrow(CryptoError);
    expect(() => unsealEnvelope(sealEnvelope(mkEnvelope({}), KEY_A), 'zz')).toThrow(CryptoError);
    expect(isValidKeyHex(KEY_A)).toBe(true);
    expect(isValidKeyHex('not-hex')).toBe(false);
    expect(keyFingerprint(KEY_A)).toBe(keyFingerprint(KEY_A));
    expect(keyFingerprint(KEY_A)).not.toBe(keyFingerprint(KEY_B));
    expect(keyFingerprint(KEY_A)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('KeyService（工作区密钥管理）', () => {
  it('generate → get：64 位 hex + 指纹 + 时间；不存在时 get 为 undefined', () => {
    const core = OneCore.open(':memory:');
    try {
      expect(core.keys.get(WS)).toBeUndefined();
      const key = core.keys.generate(WS);
      expect(isValidKeyHex(key.keyHex)).toBe(true);
      const got = core.keys.get(WS)!;
      expect(got.keyHex).toBe(key.keyHex);
      expect(got.fingerprint).toBe(key.fingerprint);
    } finally {
      core.close();
    }
  });

  it('重复 generate / 已有后 import → KeyExistsError（换密钥会使存量密文不可解）', () => {
    const core = OneCore.open(':memory:');
    try {
      core.keys.generate(WS);
      expect(() => core.keys.generate(WS)).toThrow(KeyExistsError);
      expect(() => core.keys.importKey(WS, KEY_B)).toThrow(KeyExistsError);
    } finally {
      core.close();
    }
  });

  it('importKey：格式非法 → CryptoError；合法导入后 seal/unseal 可用', () => {
    const core = OneCore.open(':memory:');
    try {
      expect(() => core.keys.importKey(WS, 'abc')).toThrow(CryptoError);
      const key = core.keys.importKey(WS, KEY_A);
      expect(key.keyHex).toBe(KEY_A);
      const sealed = sealEnvelope(mkEnvelope({ ok: true }), core.keys.get(WS)!.keyHex);
      expect(unsealEnvelope(sealed, KEY_A).payload).toEqual({ ok: true });
    } finally {
      core.close();
    }
  });

  it('多工作区密钥互不干扰 + 文件库重开仍在（持久化）', () => {
    const dbPath = join(tmpdir(), `onewms-crypto-${randomUUID()}.db`);
    const core = OneCore.open(dbPath);
    const keyA = core.keys.generate('ws-1');
    core.keys.generate('ws-2');
    core.close();

    const reopened = OneCore.open(dbPath);
    try {
      const got = reopened.keys.get('ws-1')!;
      expect(got.keyHex).toBe(keyA.keyHex);
      expect(got.fingerprint).toBe(keyA.fingerprint);
      // 重开后 generate 仍拒绝（密钥在场）
      expect(() => reopened.keys.generate('ws-1')).toThrow(KeyExistsError);
      // 未动过的工作区照常可生成
      expect(isValidKeyHex(reopened.keys.generate('ws-3').keyHex)).toBe(true);
    } finally {
      reopened.close();
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
  });
});
