import { useCallback, useRef } from 'react';
import { Alert, Steps, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import ScanInput from '../ScanInput';
import { rowsOf } from '../../api/page';
import { api } from '../../api/client';
import { useProfileSnapshot } from '../../api/hooks';
import type { Sku } from '../../api/client';

/**
 * 场景作业（module.scenario）的共享件：场景定义、设置读取、声音反馈、步骤条、扫码步。
 *
 * 场景不是新流程——它只是把既有流程「现场那一段」抽出来：一个扫码口、一条步骤序列、
 * 每步扫什么、确认走哪个工具。所有确认与表单页/AI 同源（同一批 wms.* 工具），
 * 所以现场和后台看到的是同一份账。
 */

/** 五个内置场景。id 同时是 settings.defaultScenario 的取值域。 */
export type ScenarioId = 'receive' | 'putaway' | 'pick' | 'stocktake' | 'move';

export interface ScenarioDef {
  id: ScenarioId;
  label: string;
  hint: string;
  /** 步骤序列。向导按它推进，也是页面上给现场看的提示。 */
  steps: string[];
  /** 这一步依赖哪个模块；没启用就不出现在场景选择里（与导航同一套门） */
  requiresModule?: string;
}

export const SCENARIOS: readonly ScenarioDef[] = [
  {
    id: 'receive',
    label: '收货',
    hint: '扫单 → 扫货 → 录数量 → 确认收货',
    steps: ['扫入库单号', '扫 SKU 条码', '录数量', '确认收货'],
  },
  {
    id: 'putaway',
    label: '上架',
    hint: '扫单 → 扫目标库位 → 确认上架',
    steps: ['扫入库单号', '扫目标库位', '确认上架'],
    requiresModule: 'module.putaway',
  },
  {
    id: 'pick',
    label: '拣选',
    hint: '扫拣货单 → 按路径逐位扫位扫货 → 录数量',
    steps: ['扫拣货单号', '扫库位', '扫 SKU 条码', '录数量'],
    requiresModule: 'module.picking',
  },
  {
    id: 'stocktake',
    label: '盘点',
    hint: '扫盘点单 → 扫位 → 盲录数量',
    steps: ['扫盘点单号', '扫库位', '录实盘数量'],
  },
  {
    id: 'move',
    label: '移库',
    hint: '扫源库位 → 扫货 → 录数量 → 扫目标库位',
    steps: ['扫源库位', '扫 SKU 条码', '录数量', '扫目标库位'],
  },
];

export function scenarioById(id: ScenarioId): ScenarioDef {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
}

// ── 设置（module.scenario/settings；缺省值与 manifest 一致）───────────────

export type PickPathStrategy = 'locationCode' | 'pickZoneFirst';

export interface ScenarioSettings {
  defaultScenario: ScenarioId;
  pickPathStrategy: PickPathStrategy;
  feedbackSound: boolean;
}

/**
 * 读 profile 里的场景设置。装完没改过 → settings 缺席，逐项回落 manifest 的缺省值。
 * 改这三项走慢通道（路径 /modules/module.scenario/settings/xxx），现场不自行生效。
 */
export function useScenarioSettings(): ScenarioSettings {
  const snapshot = useProfileSnapshot();
  const settings = snapshot.data?.modules['module.scenario']?.settings;
  const raw = settings?.defaultScenario;
  const strategy = settings?.pickPathStrategy;
  return {
    defaultScenario: SCENARIOS.some((s) => s.id === raw) ? (raw as ScenarioId) : 'receive',
    pickPathStrategy: strategy === 'pickZoneFirst' ? 'pickZoneFirst' : 'locationCode',
    feedbackSound: settings?.feedbackSound !== false,
  };
}

// ── 声音反馈（feedbackSound；成功短促一声，失败低沉两声）──────────────────

/**
 * 用 WebAudio 现合成，不引音频资源：现场只关心「响了没响、是哪种」。
 * 没有音频设备 / 浏览器拦自动播放时静默失败——声音是辅助，不能挡住作业。
 */
export function useBeeper(enabled: boolean) {
  const ctxRef = useRef<AudioContext | null>(null);
  return useCallback(
    (ok: boolean) => {
      if (!enabled) return;
      try {
        const w = window as Window & { webkitAudioContext?: typeof AudioContext };
        const Ctor = window.AudioContext ?? w.webkitAudioContext;
        if (!Ctor) return;
        const ctx = (ctxRef.current ??= new Ctor());
        if (ctx.state === 'suspended') void ctx.resume();
        const times = ok ? [0] : [0, 0.14];
        for (const offset of times) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = ok ? 'sine' : 'square';
          osc.frequency.value = ok ? 880 : 220;
          gain.gain.value = 0.06;
          osc.connect(gain).connect(ctx.destination);
          const t = ctx.currentTime + offset;
          osc.start(t);
          osc.stop(t + (ok ? 0.08 : 0.12));
        }
      } catch {
        // 没声音不影响确认结果
      }
    },
    [enabled],
  );
}

// ── 扫码值归一（条码优先，其次编码）───────────────────────────────────────

/**
 * 一次扫码既可能是条码也可能是编码：现场不区分，扫到什么就试什么。
 * 条码精确命中优先，其次编码忽略大小写命中，都没有返回 null。
 * 走服务端查而不是把整份 SKU 拉到前端——现场只关心扫到的那一个。
 */
export function useScannedSku(code: string | null) {
  return useQuery({
    queryKey: ['skus', 'scan', code ?? ''],
    queryFn: async (): Promise<Sku | null> => {
      const v = code!.trim();
      const byBarcode = rowsOf<Sku>(await api.skus({ barcode: v, limit: 1 }));
      if (byBarcode.length > 0) return byBarcode[0];
      const byQuery = rowsOf<Sku>(await api.skus({ q: v, limit: 5 }));
      return byQuery.find((s) => s.skuCode.toLowerCase() === v.toLowerCase()) ?? null;
    },
    enabled: !!code,
  });
}

/** 库位 → 库区编码。只在 pickPathStrategy=pickZoneFirst 时才拉，用于拣选路径排序。 */
export function useLocationZoneMap(enabled: boolean) {
  return useQuery({
    queryKey: ['locations', 'zone-map'],
    queryFn: async () => {
      const list = await api.locations();
      const map = new Map<string, string>();
      for (const loc of list) if (loc.zoneCode) map.set(loc.locationCode, loc.zoneCode);
      return map;
    },
    enabled,
    staleTime: 60_000,
  });
}

// ── 共享 UI ──────────────────────────────────────────────────────────────

/** 步骤条：当前步高亮，已完成的步打勾。现场一眼知道扫到哪了。 */
export function StepBar({ steps, active }: { steps: readonly string[]; active: number }) {
  return (
    <Steps
      size="small"
      current={Math.max(0, Math.min(active, steps.length - 1))}
      items={steps.map((title) => ({ title }))}
      style={{ marginBottom: 16 }}
    />
  );
}

/** 一步一个扫码口：label 说清这一步扫什么，focus 自动落在输入框上 */
export function ScanStep({
  label,
  onScan,
  placeholder,
  disabled,
}: {
  label: string;
  onScan: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <Typography.Text strong>{label}</Typography.Text>
      <div style={{ marginTop: 6 }}>
        <ScanInput onScan={onScan} placeholder={placeholder} style={{ width: '100%' }} size="large" />
      </div>
      {disabled ? <Typography.Text type="secondary">（当前不可扫）</Typography.Text> : null}
    </div>
  );
}

/** 结果条：成功绿、失败红。每次确认都要有明确回话，现场不看日志。 */
export function ResultBanner({
  kind,
  text,
}: {
  kind: 'success' | 'error' | 'info';
  text: string;
}) {
  if (!text) return null;
  return <Alert type={kind} message={text} showIcon style={{ marginTop: 12 }} />;
}
