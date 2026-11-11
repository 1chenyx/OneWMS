import type { WmsWorkspace } from '../src/wms.js';

const STAGE_MODULES = ['module.qc', 'module.wave', 'module.review', 'module.pack', 'module.load'] as const;

/**
 * 这些用例不走质检、波次、复核、打包、装车。
 * 这些步骤开着时，单据不能跳过。一次关掉，已经进入该步的单仍可做完。
 */
export function releaseFlowGates(ws: WmsWorkspace): void {
  const snapshot = ws.profile.getSnapshot();
  const patch = STAGE_MODULES.filter((id) => snapshot.modules[id]?.enabled === true).map((id) => ({
    op: 'replace' as const,
    path: `/modules/${id}/enabled`,
    value: false,
  }));
  if (patch.length === 0) return;
  const { proposalId } = ws.profile.propose('user:tester', patch, '测试跳过质检、波次、复核、打包、装车');
  ws.profile.confirm(proposalId, 'user:tester');
}

/**
 * 这些用例要的是发货扣账，不是拣货单，也不走波次、复核、打包、装车。
 * 拣货开着时，单据流转不能直接发货。先关掉拣货，已经在拣货中的单仍可发货。
 */
export function allowDirectShip(ws: WmsWorkspace): void {
  releaseFlowGates(ws);
  if (ws.profile.getSnapshot().modules['module.picking']?.enabled !== true) return;
  const { proposalId } = ws.profile.propose(
    'user:tester',
    [{ op: 'replace', path: '/modules/module.picking/enabled', value: false }],
    '测试直接发货',
  );
  ws.profile.confirm(proposalId, 'user:tester');
}

/** 测完直接发货后，把拣货开关拨回去，后面的单还能进入拣货。 */
export function restorePicking(ws: WmsWorkspace): void {
  if (ws.profile.getSnapshot().modules['module.picking']?.enabled === true) return;
  const { proposalId } = ws.profile.propose(
    'user:tester',
    [{ op: 'replace', path: '/modules/module.picking/enabled', value: true }],
    '测试恢复拣货',
  );
  ws.profile.confirm(proposalId, 'user:tester');
}
