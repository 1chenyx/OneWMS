import { ApiError, request } from './request';

/** 与 @one/ai 的 AgentStreamEvent 同形（前端不依赖 ai 包类型，只镜像 SSE 契约） */
export type ChatStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; callId: string; toolId: string; args: Record<string, unknown> }
  /** ui.ask 挂起：渲染回答输入卡，回答经 answerChatAsk 提交后流继续 */
  | { type: 'ask'; callId: string; question: string }
  | { type: 'tool-result'; callId: string; toolId: string; ok: boolean; payload: unknown }
  | { type: 'turn-done'; steps: number }
  | { type: 'error'; message: string };

/** 一轮对话里的一次工具调用（流式推进：tool-call 事件先落卡，tool-result 回填结果） */
export interface ChatInvocation {
  callId: string;
  toolId: string;
  args: Record<string, unknown>;
  /** undefined = 执行中（tool-result 事件未到） */
  ok?: boolean;
  payload?: unknown;
}

/** 用户导入的文件。表格按行给模型，文本按原文给模型。 */
export interface ChatAttachmentPayload {
  id: string;
  name: string;
  kind: 'table' | 'text';
  headers: string[];
  rows: string[][];
  text: string;
}

/** 气泡上的文件摘要，不把整表留在界面状态里 */
export interface ChatAttachmentChip {
  id: string;
  name: string;
  kind: 'table' | 'text';
  rows?: number;
}

/**
 * 发送一条消息并逐事件消费 SSE 流（agentId 选助手，缺省 'general'）。
 * 非流式错误（503/400/404/409 等 JSON 响应）统一抛 ApiError——UI 按 code 分支提示。
 */
export async function streamChatMessage(
  sessionId: string,
  message: string,
  agentId: string,
  onEvent: (ev: ChatStreamEvent) => void,
  attachments?: ChatAttachmentPayload[],
): Promise<void> {
  const res = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message,
      agentId,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    }),
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new ApiError(body.code ?? 'UNKNOWN', body.message ?? `请求失败（${res.status}）`, res.status);
  }
  await consumeSse(res.body, onEvent);
}

/** 回答挂起的 ui.ask（answer 为 null 表示跳过）——原 SSE 连接收回答后继续 */
export async function answerChatAsk(
  sessionId: string,
  callId: string,
  answer: string | null,
): Promise<void> {
  await request<{ ok: boolean }>(`/api/chat/sessions/${encodeURIComponent(sessionId)}/answer`, {
    method: 'POST',
    body: JSON.stringify(answer === null ? { callId, declined: true } : { callId, answer }),
  });
}

/** 解析 text/event-stream 响应体：按空行切块、拼 data 行、JSON 反序列化后回调 */
async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (ev: ChatStreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as ChatStreamEvent);
      } catch {
        // 无法解析的块直接丢弃（协议外噪音，不让流消费中断）
      }
    }
  }
}
