import { useEffect, useRef, useState } from 'react';
import { App as AntApp } from 'antd';
import { ApiError } from '../api/client';
import type { ProposeResponse } from '../api/profile-api';
import { useConfirmProposal, useProposeProfile, useRejectProposal } from '../api/hooks';

/**
 * 规则页上的编号规则。一次提交整份模板，确认后才写入。
 * 离开页面时放弃还没生效的提议。
 */

interface NumberingPatch {
  op: 'add' | 'replace';
  path: string;
  value: unknown;
}

interface PendingReview {
  id: string;
  text: string;
  report: ProposeResponse['report'];
}

export function useNumberingRules() {
  const { message } = AntApp.useApp();
  const propose = useProposeProfile();
  const confirm = useConfirmProposal();
  const reject = useRejectProposal();
  const [pending, setPending] = useState<PendingReview | null>(null);
  const [draftText, setDraftText] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
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

  const preview = pending ?? (draftText ? { text: draftText } : null);

  const start = async (next: { text: string; note: string; patch: NumberingPatch[] }) => {
    if (pendingRef.current || reviewingRef.current) return;
    const gen = reviewGen.current + 1;
    reviewGen.current = gen;
    reviewingRef.current = true;
    setDraftText(next.text);
    try {
      const result = await propose.mutateAsync({
        patch: next.patch,
        note: `规则：${next.note}`,
      });
      if (reviewGen.current !== gen) {
        rejectRef.current(result.proposalId);
        return;
      }
      const stored = { text: next.text, id: result.proposalId, report: result.report };
      pendingRef.current = stored;
      setPending(stored);
    } catch (error) {
      if (reviewGen.current === gen) {
        setDraftText(null);
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
    setDraftText(null);
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
      setDraftText(null);
      setGeneration((value) => value + 1);
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
    generation,
    start,
    dismiss,
    apply,
  };
}
