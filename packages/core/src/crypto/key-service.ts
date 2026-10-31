import { randomBytes } from 'node:crypto';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { CryptoError, KeyExistsError } from '../errors.js';
import { isValidKeyHex, keyFingerprint } from './seal.js';

/** 密钥信息形态（不含密钥本体时也可展示：指纹 + 时间） */
export interface WorkspaceKeyInfo {
  fingerprint: string;
  createdAt: string;
}

/** 密钥全量形态（含本体——仅本地可信域出库，人工交给新节点） */
export interface WorkspaceKey extends WorkspaceKeyInfo {
  keyHex: string;
}

/**
 * 工作区密钥管理（KeyService，DESIGN §8.5 传输安全，里程碑 7）。
 *
 * 每工作区一把 256-bit 对称密钥（AES-256-GCM 的 seal/unseal 用）。
 *  - 持久化在 workspace_keys 表——密钥是边界参数（与 nodeId 同类），不是业务事实，不经事件；
 *  - generate/import 对已存在的工作区一律拒绝（KeyExistsError）：
 *    换密钥会使中继上的存量密文不可解；确需换钥 = 开新工作区；
 *  - 不做出库分发策略（export 端点在宿主层，人工交换是用户动作）。
 */
export class KeyService {
  constructor(private readonly db: SqliteDatabase) {}

  /** 生成新密钥（已有 → KeyExistsError）。返回一次明文本体——调用方自行展示/丢弃。 */
  generate(workspaceId: string): WorkspaceKey {
    if (this.get(workspaceId)) {
      throw new KeyExistsError(`工作区 ${workspaceId} 已有密钥（换密钥会使存量密文不可解；确需更换请使用新工作区）`);
    }
    const keyHex = randomBytes(32).toString('hex');
    const createdAt = new Date().toISOString();
    this.db
      .prepare('INSERT INTO workspace_keys (workspace_id, key_hex, created_at) VALUES (?, ?, ?)')
      .run(workspaceId, keyHex, createdAt);
    return { keyHex, fingerprint: keyFingerprint(keyHex), createdAt };
  }

  /** 查询密钥（无则 undefined） */
  get(workspaceId: string): WorkspaceKey | undefined {
    const row = this.db
      .prepare<unknown[], { key_hex: string; created_at: string }>(
        'SELECT key_hex, created_at FROM workspace_keys WHERE workspace_id = ?',
      )
      .get(workspaceId);
    if (!row) return undefined;
    return { keyHex: row.key_hex, fingerprint: keyFingerprint(row.key_hex), createdAt: row.created_at };
  }

  /** 导入密钥（人工交换的落点；格式非法 → CryptoError；已有 → KeyExistsError） */
  importKey(workspaceId: string, keyHex: string): WorkspaceKey {
    if (!isValidKeyHex(keyHex)) {
      throw new CryptoError('工作区密钥必须是 64 位 hex（256-bit）字符串');
    }
    if (this.get(workspaceId)) {
      throw new KeyExistsError(`工作区 ${workspaceId} 已有密钥（换密钥会使存量密文不可解；确需更换请使用新工作区）`);
    }
    const createdAt = new Date().toISOString();
    this.db
      .prepare('INSERT INTO workspace_keys (workspace_id, key_hex, created_at) VALUES (?, ?, ?)')
      .run(workspaceId, keyHex, createdAt);
    return { keyHex, fingerprint: keyFingerprint(keyHex), createdAt };
  }
}
