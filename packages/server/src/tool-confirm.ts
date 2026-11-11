import { randomUUID } from 'node:crypto';

/**
 * 写操作二次确认闸门（B.5）。
 *
 * 为什么需要它：B.3 的记录端点 + B.4 的 dyn 工具一开放，「全部写操作」就有了通用入口。
 * 读操作随便调（调错也不留痕），写操作必须有人在界面上点一次「确认」才落地。
 * 注意这不是权限——`permission` 仍是 read/write 二值（§B.5 明确不扩枚举），
 * 这里是**动作级**的人为闸门：同一个 write 工具，走通用端点就要确认，
 * 走既有点名端点（/api/wms/*、/api/dyn/*）仍是原来的直连语义。
 *
 * 形态：invoke 写工具 → 返回一次性令牌（**不执行**）；前端弹确认框；
 *      用户点确认 → 带令牌二次提交 → 此刻才真正执行。
 *
 * 令牌存内存（Map + TTL），不落库、不进事件账：
 *  - 它是分钟级的 UI 临时状态，不是业务真相；业务真相是执行时 handler 落的领域事件。
 *  - 进程重启令牌全失效 → 前端拿到「令牌不存在」，重新发起一次即可，没有数据损失。
 *  - ⚠️ 因此令牌不跨进程；本仓库 v1 是单进程单机（ONE_WORKSPACE），不构成问题。
 *    真要多进程，把 Map 换成一张表即可，调用点不动。
 *
 * 防双写靠两层，缺一不可：
 *  1. TTL 过期即废——过期确认是 409，不会静默执行一个几分钟前的旧意图；
 *  2. 令牌本身当幂等键传给 ToolsView.invoke → 命中既有 tool_idempotency 表，
 *     同一令牌的第二次执行**回放首次结果**而不重跑 handler（双击/网络重发都安全）。
 *     ⚠️ 该表只缓存成功：首次失败的重试会真的重跑 handler，这是有意的
 *     （失败原因往往是版本冲突，重跑仍会失败，不会造成双写）。
 */

/** 令牌有效期：5 分钟。够人在确认框上读完文案，又不至于让旧意图长期可执行。 */
export const CONFIRM_TOKEN_TTL_MS = 5 * 60 * 1000;

/** 一张待确认的写操作令牌。签发时冻结，确认时原样执行（不接受新参数）。 */
export interface PendingWrite {
  readonly token: string;
  readonly workspaceId: string;
  readonly toolId: string;
  /** 工具中文名：回给前端渲染确认框标题，省掉「再查一次目录」的往返 */
  readonly label: string;
  readonly params: Record<string, unknown>;
  /** 发起人。确认时用它而不是重新解析——「谁申请的」就该记在谁名下 */
  readonly actor: string;
  readonly createdAt: string;
  /** epoch ms（前端可据此显示倒计时） */
  readonly expiresAt: number;
}

/** 令牌无效：不存在 / 已过期 / 串了工具或工作区。客户端问题 → 409，见 errors.ts */
export class ConfirmTokenError extends Error {
  readonly code = 'CONFIRM_TOKEN_INVALID' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ConfirmTokenError';
  }
}

/** 待确认令牌的签发/校验口（进程级单例，挂在 AppContext.confirmations） */
export class ConfirmGate {
  readonly #pending = new Map<string, PendingWrite>();

  /**
   * @param ttlMs 令牌有效期。构造期给定（宿主可注入，测试用它复现过期），
   *              issue 也可逐次覆盖。
   */
  constructor(private readonly ttlMs: number = CONFIRM_TOKEN_TTL_MS) {}

  /** 签发一张令牌 */
  issue(
    entry: Omit<PendingWrite, 'token' | 'createdAt' | 'expiresAt'>,
    ttlMs: number = this.ttlMs,
  ): PendingWrite {
    this.#sweep();
    const now = Date.now();
    const pending: PendingWrite = {
      ...entry,
      token: randomUUID(),
      createdAt: new Date(now).toISOString(),
      expiresAt: now + ttlMs,
    };
    this.#pending.set(pending.token, pending);
    return pending;
  }

  /**
   * 校验并取出令牌。**取出不删除**：删了就没法让重发回放首次结果，
   * 一次性语义交给 tool_idempotency（令牌即幂等键）去保证。
   * 过期项由 #sweep 回收，所以「过期」与「不存在」对调用方是同一个结论。
   */
  consume(token: string, expect: { workspaceId: string; toolId: string }): PendingWrite {
    this.#sweep();
    const entry = this.#pending.get(token);
    if (entry === undefined) {
      throw new ConfirmTokenError('确认令牌不存在或已过期，请重新发起该操作');
    }
    // 串工具 / 串工作区：令牌只能执行它签发时那一个工具。
    // ⚠️ 少这两行，任意一张令牌就成了万能钥匙——拿到令牌即可执行别的写操作。
    if (entry.toolId !== expect.toolId) {
      throw new ConfirmTokenError(`令牌是给工具 ${entry.toolId} 的，不能用于 ${expect.toolId}`);
    }
    if (entry.workspaceId !== expect.workspaceId) {
      throw new ConfirmTokenError('令牌属于另一个工作区，当前工作区不能用');
    }
    return entry;
  }

  /** 惰性清扫：不起定时器（定时器会吊住测试进程，还得管卸载时机） */
  #sweep(): void {
    const now = Date.now();
    for (const [token, entry] of this.#pending) {
      if (entry.expiresAt <= now) this.#pending.delete(token);
    }
  }
}
