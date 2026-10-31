import { PatchError } from '../errors.js';
import type { PatchOp } from './profile-types.js';

/**
 * JSON Patch 应用器（RFC 6902 子集：add / replace / remove）。
 *
 * 基础层纯函数：不改源对象（深克隆后应用）、不碰数据库、
 * 不做语义校验（那是 validate.ts 的职责）。
 *
 * 与完整 RFC 6902 的差异（刻意裁剪）：
 *  - 不支持 move / copy / test；
 *  - 数组 add 支持 '-'（追加到末尾）与数字索引（插入）；
 *  - 路径转义（~0/~1）不支持——Profile 的 key 命名域不含 '~' 与 '/'。
 */

/** 解析 JSON Pointer：'/workflows/outbound/states/0' → ['workflows', 'outbound', 'states', '0'] */
export function parsePointer(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) {
    throw new PatchError(`patch 路径必须以 / 开头: "${path}"`);
  }
  return path.slice(1).split('/');
}

/** 在深克隆的对象上按序应用全部操作，返回新对象；任何一步失败整体抛错（源不受影响） */
export function applyPatch<T extends object>(target: T, ops: PatchOp[]): T {
  const draft = structuredClone(target);
  for (const op of ops) {
    applyOne(draft, op);
  }
  return draft;
}

function applyOne(root: object, op: PatchOp): void {
  const segments = parsePointer(op.path);
  if (segments.length === 0) {
    throw new PatchError(`patch 路径不能指向根: "${op.path}"`);
  }

  // 沿路径走到父容器（中间段必须存在且为容器）
  let parent: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    parent = getChild(parent, segments[i], `${op.path} 的第 ${i + 1} 段`);
  }

  const last = segments[segments.length - 1];

  switch (op.op) {
    case 'add':
      setChild(parent, last, op.value, op.path, { create: true });
      break;
    case 'replace':
      setChild(parent, last, op.value, op.path, { create: false });
      break;
    case 'remove':
      removeChild(parent, last, op.path);
      break;
  }
}

function getChild(container: unknown, segment: string, where: string): unknown {
  if (Array.isArray(container)) {
    const idx = arrayIndex(container, segment, where);
    return container[idx];
  }
  if (isPlainObject(container)) {
    if (!(segment in container)) {
      throw new PatchError(`patch 路径中间段不存在: ${where}（"${segment}"）`);
    }
    return (container as Record<string, unknown>)[segment];
  }
  throw new PatchError(`patch 路径中间段不是容器: ${where}（"${segment}"）`);
}

function setChild(
  parent: unknown,
  last: string,
  value: unknown,
  path: string,
  opts: { create: boolean },
): void {
  if (Array.isArray(parent)) {
    if (last === '-') {
      if (!opts.create) throw new PatchError(`数组不能用 '-' 做 replace: "${path}"`);
      parent.push(value);
      return;
    }
    const idx = arrayIndex(parent, last, `"${path}" 的数组索引`);
    if (opts.create) {
      if (idx < 0 || idx > parent.length) {
        throw new PatchError(`数组插入索引越界: "${path}"（长度 ${parent.length}）`);
      }
      parent.splice(idx, 0, value);
    } else {
      if (idx < 0 || idx >= parent.length) {
        throw new PatchError(`数组替换索引越界: "${path}"（长度 ${parent.length}）`);
      }
      parent[idx] = value;
    }
    return;
  }
  if (isPlainObject(parent)) {
    if (!opts.create && !(last in parent)) {
      throw new PatchError(`replace 目标不存在: "${path}"`);
    }
    (parent as Record<string, unknown>)[last] = value;
    return;
  }
  throw new PatchError(`patch 目标父级不是容器: "${path}"`);
}

function removeChild(parent: unknown, last: string, path: string): void {
  if (Array.isArray(parent)) {
    const idx = arrayIndex(parent, last, `"${path}" 的数组索引`);
    if (idx < 0 || idx >= parent.length) {
      throw new PatchError(`数组删除索引越界: "${path}"（长度 ${parent.length}）`);
    }
    parent.splice(idx, 1);
    return;
  }
  if (isPlainObject(parent)) {
    if (!(last in parent)) {
      throw new PatchError(`remove 目标不存在: "${path}"`);
    }
    delete (parent as Record<string, unknown>)[last];
    return;
  }
  throw new PatchError(`patch 目标父级不是容器: "${path}"`);
}

function arrayIndex(arr: unknown[], segment: string, where: string): number {
  if (!/^\d+$/.test(segment)) {
    throw new PatchError(`数组索引必须是数字: ${where}（"${segment}"）`);
  }
  const idx = Number(segment);
  // RFC 6902：前导零非法（01 ≠ 1）
  if (segment.length > 1 && segment.startsWith('0')) {
    throw new PatchError(`数组索引不能有前导零: ${where}（"${segment}"）`);
  }
  void arr;
  return idx;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
