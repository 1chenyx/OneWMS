import { useMemo, useState, type ComponentType } from 'react';
import { Card, Empty, Segmented, Typography } from 'antd';
import { useProfileSnapshot } from '../api/hooks';
import PageHeader from '../components/PageHeader';
import ReceiveScenario from '../components/scenario/ReceiveScenario';
import PutawayScenario from '../components/scenario/PutawayScenario';
import PickScenario from '../components/scenario/PickScenario';
import StocktakeScenario from '../components/scenario/StocktakeScenario';
import MoveScenario from '../components/scenario/MoveScenario';
import { SCENARIOS, scenarioById, useScenarioSettings, type ScenarioId } from '../components/scenario/shared';

const WIZARDS: Record<ScenarioId, ComponentType> = {
  receive: ReceiveScenario,
  putaway: PutawayScenario,
  pick: PickScenario,
  stocktake: StocktakeScenario,
  move: MoveScenario,
};

/**
 * 场景作业（module.scenario）：现场那一段的扫码入口。
 *
 * 它不是新流程，只是把既有流程的现场动作按「一步一屏、扫完即走」重排：
 * 五个内置场景（收货 / 上架 / 拣选 / 盘点 / 移库），确认全部走既有 wms.* 工具，
 * 与表单页、AI 同源同账。所以这一页只做三件事：选场景、给步骤提示、把扫码口摆好。
 *
 * 每个场景还受它依赖的模块门控（上架要 module.putaway、拣选要 module.picking）——
 * 模块停用，场景当场从选择器里消失，现场不会点进去撞一堵墙。
 */
export default function ScenarioPage() {
  const snapshot = useProfileSnapshot();
  const settings = useScenarioSettings();
  const [picked, setPicked] = useState<ScenarioId | null>(null);

  /** 依赖模块停用 = 这个场景不可用（缺省在场 = 启用） */
  const available = useMemo(
    () =>
      SCENARIOS.filter((s) => {
        const mod = s.requiresModule ? snapshot.data?.modules[s.requiresModule] : undefined;
        return !s.requiresModule || (mod?.enabled ?? true);
      }),
    [snapshot.data],
  );

  const active: ScenarioId = picked ?? (available.some((s) => s.id === settings.defaultScenario)
    ? settings.defaultScenario
    : (available[0]?.id ?? 'receive'));
  const def = scenarioById(active);
  const Wizard = WIZARDS[active];

  return (
    <>
      <PageHeader
        title="场景作业"
        subtitle="现场扫码入口：一个扫码口、一条步骤序列。确认与表单页、AI 走同一批工具，账只有一份。"
      />
      {available.length === 0 ? (
        <Empty description="没有可用场景：相关模块都停用了" />
      ) : (
        <>
          <Segmented<ScenarioId>
            value={active}
            onChange={(v) => setPicked(v)}
            options={available.map((s) => ({ label: s.label, value: s.id }))}
            style={{ marginBottom: 16 }}
          />
          <Card>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
              {def.hint}
            </Typography.Paragraph>
            {/* key 绑场景 id：换场景 = 整个向导重挂，上一场景扫到一半的状态不会串过来 */}
            <Wizard key={active} />
          </Card>
        </>
      )}
    </>
  );
}
