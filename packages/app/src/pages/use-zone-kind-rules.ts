import { useEffect, useRef, useState } from 'react';
import { App as AntApp } from 'antd';
import { readEnabledZoneKinds, zoneKindLabel, type ZoneKind } from '@one/wms/zone-kinds';
import { ApiError } from '../api/client';
import type { ProposeResponse } from '../api/profile-api';
import { useConfirmProposal, useProposeProfile, useRejectProposal } from '../api/hooks';

/**
 * 规则页上的库区分类。勾选这个工作区启用哪些分类，确认后才写入。
 * 和出库规则走同一条提议确认。键还不存在时用 add。
 */

const KINDS_PATH = '/modules/module.zone/settings/enabledKinds';

interface KindPatch {
  op: 'add' | 'replace';
  path: string;
  value: unknown;
}

export interface ZoneKindDraft {
  kinds: ZoneKind[];
  text: string;
}

interface PendingReview extends ZoneKindDraft {
  id: string;
  report: ProposeResponse['report'];
}

export function zoneKindPatch(settings: Record<string, unknown> | undefined, value: readonly ZoneKind[]): KindPatch[] {
  const kinds = [...value];
  if (!settings) {
    return [{ op: 'add', path: '/modules/module.zone/settings', value: { enabledKinds: kinds } }];
  }
  if (!Object.hasOwn(settings, 'enabledKinds')) {
    return [{ op: 'add', path: KINDS_PATH, value: kinds }];
  }
  return [{ op: 'replace', path: KINDS_PATH, value: kinds }];
}

export function savedZoneKinds(settings: Record<string, unknown> | undefined): ZoneKind[] {
  if (!settings || !Object.hasOwn(settings, 'enabledKinds')) return readEnabledZoneKinds(undefined);
  return readEnabledZoneKinds(settings.enabledKinds);
}

export function zoneKindChangeText(before: readonly ZoneKind[], after: readonly ZoneKind[]): string {
  const off = before.filter((id) => !after.includes(id)).map((id) => zoneKindLabel(id));
  const on = after.filter((id) => !before.includes(id)).map((id) => zoneKindLabel(id));
  const parts: string[] = [];
  if (off.length > 0) {
    const names = off.join('、');
    parts.push(`关掉${names}。之后不能新建${names}，原来的${names}不再限制作业`);
  }
  if (on.length > 0) {
    const names = on.join('、');
    parts.push(`打开${names}。之后可以新建${names}，这个分类里的库位按规则作业`);
  }
  parts.push('已经建好的库区还在');
  return `${parts.join('。')}。`;
}

export function zoneKindChangeNote(before: readonly ZoneKind[], after: readonly ZoneKind[]): string {
  const off = before.filter((id) => !after.includes(id));
  const on = after.filter((id) => !before.includes(id));
  const onlyOff = off.length === 1 ? off[0] : undefined;
  const onlyOn = on.length === 1 ? on[0] : undefined;
  if (onlyOff && on.length === 0) return `关掉${zoneKindLabel(onlyOff)}`;
  if (onlyOn && off.length === 0) return `打开${zoneKindLabel(onlyOn)}`;
  return '调整库区分类';
}

export function useZoneKindRules() {
  const { message } = AntApp.useApp();
  const propose = useProposeProfile();
  const confirm = useConfirmProposal();
  const reject = useRejectProposal();
  const [pending, setPending] = useState<PendingReview | null>(null);
  const [draft, setDraft] = useState<ZoneKindDraft | null>(null);
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

  const start = async (next: ZoneKindDraft & { note: string; patch: KindPatch[] }) => {
    if (pendingRef.current || reviewingRef.current) return;
    const gen = reviewGen.current + 1;
    reviewGen.current = gen;
    reviewingRef.current = true;
    setDraft({ kinds: next.kinds, text: next.text });
    try {
      const result = await propose.mutateAsync({
        patch: next.patch,
        note: `规则：${next.note}`,
      });
      if (reviewGen.current !== gen) {
        rejectRef.current(result.proposalId);
        return;
      }
      const stored = { kinds: next.kinds, text: next.text, id: result.proposalId, report: result.report };
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
