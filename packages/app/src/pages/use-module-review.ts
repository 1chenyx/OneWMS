import { useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp } from 'antd';
import type { ProfileSnapshot } from '@one/core';
import { ApiError } from '../api/client';
import type { ProfileCatalog, ProposeResponse } from '../api/profile-api';
import {
  useConfirmProposal,
  useProfileCatalog,
  useProfileSnapshot,
  useProposeProfile,
  useRejectProposal,
} from '../api/hooks';
import { oneLine, presentOf } from '../lib/module-present';

/**
 * 流程页和模块页共用的慢通道。
 * 拨选先记在本地，提议返回后才能确认。取消或离开页面会拒绝这次提议。
 */

export interface InstalledModule {
  id: string;
  name: string;
  line: string;
  enabled: boolean;
  system: boolean;
}

export interface ModulePreview {
  moduleId: string;
  enabled: boolean;
  /** 确认条贴在哪一处，流程页用「泳道:方块:模块」 */
  place: string;
}

interface PendingReview extends ModulePreview {
  id: string;
  report: ProposeResponse['report'];
}

export function useModuleReview(area: '流程' | '模块') {
  const { message } = AntApp.useApp();
  const snapshotQuery = useProfileSnapshot();
  const catalogQuery = useProfileCatalog();
  const propose = useProposeProfile();
  const confirm = useConfirmProposal();
  const reject = useRejectProposal();
  const [pending, setPending] = useState<PendingReview | null>(null);
  const [draft, setDraft] = useState<ModulePreview | null>(null);
  const [proposingId, setProposingId] = useState<string | null>(null);
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

  const snapshot = snapshotQuery.data;
  const installed = useMemo(
    () => (snapshot ? buildInstalled(snapshot, catalogQuery.data) : []),
    [snapshot, catalogQuery.data],
  );
  const nameOf = (id: string) => installed.find((item) => item.id === id)?.name ?? presentOf(id).name;
  const preview = pending ?? draft;

  const start = async (moduleId: string, enabled: boolean, note: string, place: string) => {
    const card = installed.find((item) => item.id === moduleId);
    if (!snapshot || !card || card.system || pendingRef.current || reviewingRef.current) return;
    if (card.enabled === enabled) return;
    const gen = reviewGen.current + 1;
    reviewGen.current = gen;
    reviewingRef.current = true;
    setDraft({ moduleId, enabled, place });
    setProposingId(moduleId);
    try {
      const result = await propose.mutateAsync({
        patch: [{ op: 'replace', path: `/modules/${moduleId}/enabled`, value: enabled }],
        note: `${area}：${note}`,
      });
      if (reviewGen.current !== gen) {
        rejectRef.current(result.proposalId);
        return;
      }
      const next = { id: result.proposalId, moduleId, enabled, place, report: result.report };
      pendingRef.current = next;
      setPending(next);
    } catch (error) {
      if (reviewGen.current === gen) {
        setDraft(null);
        message.error(error instanceof ApiError ? error.message : `提议失败：${String(error)}`);
      }
    } finally {
      if (reviewGen.current === gen) {
        reviewingRef.current = false;
        setProposingId(null);
      }
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
    setProposingId(null);
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
    snapshotQuery,
    snapshot,
    installed,
    preview,
    proposingId,
    busy: preview !== null || propose.isPending,
    confirming: confirm.isPending,
    report: pending?.report,
    nameOf,
    start,
    dismiss,
    apply,
  };
}

export function shownEnabled(card: InstalledModule, preview: ModulePreview | null): boolean {
  if (preview?.moduleId === card.id) return preview.enabled;
  return card.enabled;
}

function buildInstalled(snapshot: ProfileSnapshot, catalog: ProfileCatalog | undefined): InstalledModule[] {
  const meta = new Map((catalog?.modules ?? []).map((item) => [item.id, item]));
  return Object.entries(snapshot.modules).map(([id, config]) => {
    const item = meta.get(id);
    const present = presentOf(id);
    return {
      id,
      name: item?.name || present.name,
      line: oneLine(id, item?.description ?? ''),
      enabled: config.enabled,
      system: item?.system ?? id.startsWith('core.'),
    };
  });
}
