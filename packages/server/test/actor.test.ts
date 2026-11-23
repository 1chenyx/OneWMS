import { afterEach, describe, expect, it } from 'vitest';
import type { Context } from 'hono';
import { resolveActor } from '../src/actor.js';
import type { AppContext } from '../src/context.js';

const ctx = { core: { nodeId: 'node-abc' } } as AppContext;
const userId = '11111111-1111-4111-8111-111111111111';
const nodeId = '22222222-2222-4222-8222-222222222222';

function request(headers: Record<string, string>): Context {
  // authGuard 之外的最小桩：resolveActor 只会读 req.header 和 c.get('authUser')
  return {
    req: { header: (name: string) => headers[name.toLowerCase()] },
    get: () => undefined,
  } as Context;
}

describe('resolveActor', () => {
  afterEach(() => {
    delete process.env.ONE_TRUST_ACTOR_HEADER;
  });

  it('单机版忽略客户端带来的身份头', () => {
    expect(resolveActor(ctx, request({ 'x-one-user-id': userId, 'x-one-node-id': nodeId }))).toBe(
      'user:local@node-abc',
    );
  });

  it('平台打开开关后，用工作区登记上的 uuid 节点', () => {
    process.env.ONE_TRUST_ACTOR_HEADER = '1';
    expect(resolveActor(ctx, request({ 'x-one-user-id': userId, 'x-one-node-id': nodeId }))).toBe(
      `user:${userId}@${nodeId}`,
    );
  });

  it('身份头不完整时仍记本机操作者', () => {
    process.env.ONE_TRUST_ACTOR_HEADER = '1';
    expect(resolveActor(ctx, request({ 'x-one-user-id': userId }))).toBe('user:local@node-abc');
    expect(resolveActor(ctx, request({ 'x-one-user-id': 'local', 'x-one-node-id': nodeId }))).toBe(
      'user:local@node-abc',
    );
  });
});
