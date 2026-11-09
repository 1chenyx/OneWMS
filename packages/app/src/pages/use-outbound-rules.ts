import { useEffect, useRef, useState } from 'react';
import { App as AntApp } from 'antd';
import { ApiError } from '../api/client';
import type { ProposeResponse } from '../api/profile-api';
import { useConfirmProposal, useProposeProfile, useRejectProposal } from '../api/hooks';

/**
 * 规则页上的出库规则。和模块开关一样先提议，确认后才写入。
 * 改的是 core.wms 设置，和助手走同一条慢通道。
 */

export type AllocationRule = 'strict' | 'fifo' | 'fefo';
export type SpecifiedRule = 'prefer' | 'lock';

export const ALLOCATION_LABEL: Record<AllocationRule, string> = {
  strict: '严格桶',
  fifo: '先进先出',
  fefo: '先到期先出',
};

export interface OutboundRuleDraft {
  allocation: AllocationRule;
  blockExpired: boolean;
  batchConstraint: SpecifiedRule;
  locationConstraint: SpecifiedRule;
  place: 'outbound:allocation' | 'outbound:expired' | 'outbound:batch' | 'outbound:location';
  text: string;
}

interface PendingReview extends OutboundRuleDraft {
  id: string;
  report: ProposeResponse['report'];
}

export function readAllocation(settings: Record<string, unknown> | undefined): AllocationRule {
  const value = settings?.defaultAllocation;
  return value === 'fifo' || value === 'fefo' ? value : 'strict';
}

export function readBlockExpired(settings: Record<string, unknown> | undefined): boolean {
  return settings?.blockExpiredOutbound === true;
}

export function readSpecified(settings: Record<string, unknown> | undefined, key: string): SpecifiedRule {
  return settings?.[key] === 'lock' ? 'lock' : 'prefer';
}

export function allocationResult(rule: AllocationRule): string {
  return `批次怎么扣改为${ALLOCATION_LABEL[rule]}。没在单据上另选的，按这个扣。已经开出的单还是原来的批次。`;
}

export function expiredResult(on: boolean): string {
  return on
    ? '打开过期拦截。拣货和发货会拒绝已经过期的批次，按规则扣的时候也会跳过。已经在做的单，下次拣货或发货也按这条查。'
    : '关掉过期拦截。过期批次可以照常拣货和发货。';
}

export function specifiedResult(kind: '批次' | '库位', rule: SpecifiedRule): string {
  return rule === 'lock'
    ? `写了${kind}的行改为不能换。没在单据上另选的按这个。退货和序列号商品本来就不能换。`
    : `写了${kind}的行改为可以换。没在单据上另选的按这个。退货和序列号商品仍然不能换。`;
}

export function useOutboundRules() {
  const { message } = AntApp.useApp();
  const propose = useProposeProfile();
  const confirm = useConfirmProposal();
  const reject = useRejectProposal();
  const [pending, setPending] = useState<PendingReview | null>(null);
  const [draft, setDraft] = useState<OutboundRuleDraft | null>(null);
  const pendingRef = useRef<PendingReview | null>(null);
  const reviewingRef = useRef(false);
  const reviewGen = useRef(0);
  const rejectRef = useRef(reject.mutate);
  rejectRef.current = reject.mutate;

  useEffect(() => {
    return () => {
      const id = pendingRef.current?.id;
      if (id) rejectRef.current(id);
    };
  }, []);

  const preview = pending ?? draft;

  const start = async (next: OutboundRuleDraft, note: string, path: string, value: unknown) => {
    if (pendingRef.current || reviewingRef.current) return;
    const gen = reviewGen.current + 1;
    reviewGen.current = gen;
    reviewingRef.current = true;
    setDraft(next);
    try {
      const result = await propose.mutateAsync({
        patch: [{ op: 'replace', path, value }],
        note: `规则：${note}`,
      });
      if (reviewGen.current !== gen) {
        rejectRef.current(result.proposalId);
        return;
      }
      const stored = { ...next, id: result.proposalId, report: result.report };
      pendingRef.current = stored;
      setPending(stored);
    } catch (error) {
      if (reviewGen.current === gen) {
        setDraft(null);
        message.error(error instanceof ApiError ? error.message : `提议失败：${String(error)}`);
      }
    } finally {
      if (reviewGen.current === gen) reviewingRef.current = false;
    }
  };

  const dismiss = () => {
    if (confirm.isPending) return;
    reviewGen.current += 1;
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    setDraft(null);
    reviewingRef.current = false;
    if (!current) return;
    reject.mutate(current.id, {
      onError: () => message.warning('这次没有生效，但提议还留在待确认里'),
    });
  };

  const apply = async () => {
    const current = pendingRef.current;
    if (!current) return;
    try {
      const result = await confirm.mutateAsync({ id: current.id });
      pendingRef.current = null;
      setPending(null);
      setDraft(null);
      message.success(`已生效（v${result.newVersion}）`);
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : `确认失败：${String(error)}`);
    }
  };

  return {
    preview,
    busy: preview !== null || propose.isPending,
    confirming: confirm.isPending,
    report: pending?.report,
    start,
    dismiss,
    apply,
  };
}
