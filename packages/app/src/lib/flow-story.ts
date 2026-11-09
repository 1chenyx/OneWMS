import type { ModuleConfig, WorkflowDef } from '@one/core';
import { evalWhenCondition } from '@one/core/when';

/**
 * 把一条流程说成「现在会走的主步骤」。
 *
 * 主步骤优先走进模块贡献的状态（到货预报、上架），抄近路留在旁边。
 * `canceled` 是取消出口，不排进主步骤。条件不成立的边单独列成「还没打开」。
 * states[0] 是初始状态。
 */

/** 取消出口。不排进主步骤，只作为旁边的「可以取消」。 */
const CANCEL_STATE = 'canceled';

const WHEN_RE = /^(!?)(module\.[A-Za-z0-9][A-Za-z0-9._-]*)\.enabled$/;

export interface SideEdge {
  to: string;
  /** skip = 抄近路到主步骤上更后面的状态；cancel = 取消；other = 其余活边 */
  kind: 'skip' | 'cancel' | 'other';
}

export interface DormantEdge {
  /** 这条边从主步骤上的哪个状态出发 */
  from: string;
  to: string;
  moduleId: string;
  /** true = 打开该模块后这条边才走得通 */
  enableToActivate: boolean;
  /** true = 目标不在主步骤上，适合画成插进去的一步 */
  insertsState: boolean;
}

export interface FlowStep {
  id: string;
  providedBy?: string;
  sides: SideEdge[];
}

export interface FlowStory {
  steps: FlowStep[];
  /** 条件未满足、且会插入新状态的边 */
  dormantInserts: DormantEdge[];
  /** 条件未满足、但目标已经在主步骤上（或是取消）的边 */
  dormantActions: DormantEdge[];
}

export interface ActiveEdge {
  from: string;
  to: string;
}

export interface StoryChange {
  pathBefore: string[];
  pathAfter: string[];
  gained: ActiveEdge[];
  lost: ActiveEdge[];
}

/** 页面上的一步。关掉的可选步骤仍留在原位，active 为 false。 */
export interface RecipeStep {
  id: string;
  active: boolean;
  /** 这一步由哪个模块放进流程。有它，页面才在这一步上放开关。 */
  moduleId?: string;
  /** 这一步开着，并且上一步可以直接走到下一步。 */
  skipTo?: string;
}

export function stateLabel(workflow: WorkflowDef, id: string): string {
  return workflow.states.find((state) => state.id === id)?.label || id;
}

export function activeEdges(workflow: WorkflowDef, modules: Record<string, ModuleConfig>): ActiveEdge[] {
  return workflow.transitions
    .filter((edge) => evalWhenCondition(edge.when, modules))
    .map((edge) => ({ from: edge.from, to: edge.to }));
}

export function diffStory(
  workflow: WorkflowDef,
  before: Record<string, ModuleConfig>,
  after: Record<string, ModuleConfig>,
): StoryChange {
  const previous = activeEdges(workflow, before);
  const next = activeEdges(workflow, after);
  const previousKeys = new Set(previous.map(edgeKey));
  const nextKeys = new Set(next.map(edgeKey));
  return {
    pathBefore: buildFlowStory(workflow, before).steps.map((step) => step.id),
    pathAfter: buildFlowStory(workflow, after).steps.map((step) => step.id),
    gained: next.filter((edge) => !previousKeys.has(edgeKey(edge))),
    lost: previous.filter((edge) => !nextKeys.has(edgeKey(edge))),
  };
}

export function buildFlowStory(workflow: WorkflowDef, modules: Record<string, ModuleConfig>): FlowStory {
  const start = workflow.states[0]?.id;
  if (!start) return { steps: [], dormantInserts: [], dormantActions: [] };

  const providedBy = new Map(workflow.states.map((state) => [state.id, state.providedBy]));
  const mainIds = walkMain(workflow, modules, start, providedBy);
  const mainSet = new Set(mainIds);
  const steps = mainIds.map((id, index) => ({
    id,
    ...(providedBy.get(id) ? { providedBy: providedBy.get(id) } : {}),
    sides: sideEdges(workflow, modules, id, mainIds, index),
  }));

  const dormantInserts: DormantEdge[] = [];
  const dormantActions: DormantEdge[] = [];
  const seenInsert = new Set<string>();
  for (const edge of workflow.transitions) {
    if (evalWhenCondition(edge.when, modules)) continue;
    if (!mainSet.has(edge.from)) continue;
    const gate = moduleGate(edge.when);
    if (!gate) continue;
    const dormant: DormantEdge = {
      from: edge.from,
      to: edge.to,
      moduleId: gate.moduleId,
      enableToActivate: gate.enableToActivate,
      insertsState: !mainSet.has(edge.to) && edge.to !== CANCEL_STATE,
    };
    if (dormant.insertsState) {
      if (seenInsert.has(edge.to)) continue;
      seenInsert.add(edge.to);
      dormantInserts.push(dormant);
    } else {
      dormantActions.push(dormant);
    }
  }

  return { steps, dormantInserts, dormantActions };
}

/**
 * 完整路径：可选步骤按打开后的位置排好，关掉的标成不在当前路径上。
 * 只把「会多出一个状态」的模块临时打开来排位置，不改冲销这类不新增状态的规矩。
 */
export function buildFlowRecipe(workflow: WorkflowDef, modules: Record<string, ModuleConfig>): RecipeStep[] {
  const stageIds = workflow.states.flatMap((state) => (state.providedBy ? [state.providedBy] : []));
  const opened: Record<string, ModuleConfig> = { ...modules };
  for (const id of stageIds) {
    const current = opened[id];
    opened[id] = current ? { ...current, enabled: true } : { enabled: true };
  }
  const full = buildFlowStory(workflow, opened).steps.map((step) => step.id);
  const live = new Set(buildFlowStory(workflow, modules).steps.map((step) => step.id));
  const providedBy = new Map(workflow.states.map((state) => [state.id, state.providedBy]));
  const steps: RecipeStep[] = full.map((id) => {
    const moduleId = providedBy.get(id);
    return { id, active: live.has(id), ...(moduleId ? { moduleId } : {}) };
  });
  for (const step of steps) {
    if (!step.active || !step.moduleId) continue;
    const index = steps.findIndex((item) => item.id === step.id);
    const prev = [...steps.slice(0, index)].reverse().find((item) => item.active);
    const next = steps.slice(index + 1).find((item) => item.active);
    if (!prev || !next) continue;
    const bypass = workflow.transitions.some(
      (edge) => edge.from === prev.id && edge.to === next.id && evalWhenCondition(edge.when, modules),
    );
    if (bypass) step.skipTo = next.id;
  }
  return steps;
}

function edgeKey(edge: ActiveEdge): string {
  return `${edge.from}->${edge.to}`;
}

function moduleGate(when: string | undefined): { moduleId: string; enableToActivate: boolean } | undefined {
  if (!when) return undefined;
  const match = WHEN_RE.exec(when.trim());
  if (!match) return undefined;
  return { moduleId: match[2] ?? '', enableToActivate: match[1] !== '!' };
}

function forwardFrom(workflow: WorkflowDef, modules: Record<string, ModuleConfig>, from: string): ActiveEdge[] {
  return workflow.transitions
    .filter(
      (edge) =>
        edge.from === from &&
        edge.to !== from &&
        edge.to !== CANCEL_STATE &&
        evalWhenCondition(edge.when, modules),
    )
    .map((edge) => ({ from: edge.from, to: edge.to }));
}

function walkMain(
  workflow: WorkflowDef,
  modules: Record<string, ModuleConfig>,
  start: string,
  providedBy: Map<string, string | undefined>,
): string[] {
  const visited = new Set<string>();
  const main: string[] = [];
  let cursor: string | undefined = start;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    main.push(cursor);
    cursor = preferredTo(workflow, modules, cursor, providedBy);
  }
  return main;
}

/** 有模块贡献的下一步时走那一步，让可选步骤出现在主线上；否则走还能继续的边。 */
function preferredTo(
  workflow: WorkflowDef,
  modules: Record<string, ModuleConfig>,
  from: string,
  providedBy: Map<string, string | undefined>,
): string | undefined {
  const forward = forwardFrom(workflow, modules, from);
  if (forward.length === 0) return undefined;
  const intoProvided = forward.filter((edge) => providedBy.get(edge.to));
  const pool = intoProvided.length > 0 ? intoProvided : forward;
  const continuing = pool.filter((edge) => forwardFrom(workflow, modules, edge.to).length > 0);
  return (continuing[0] ?? pool[0])?.to;
}

function sideEdges(
  workflow: WorkflowDef,
  modules: Record<string, ModuleConfig>,
  from: string,
  mainIds: string[],
  index: number,
): SideEdge[] {
  const nextId = mainIds[index + 1];
  const extras = workflow.transitions.filter(
    (edge) => edge.from === from && edge.to !== nextId && evalWhenCondition(edge.when, modules),
  );
  const sides: SideEdge[] = [];
  const seen = new Set<string>();
  const push = (to: string, kind: SideEdge['kind']) => {
    const key = `${kind}:${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    sides.push({ to, kind });
  };
  for (const edge of extras) {
    if (edge.to === CANCEL_STATE) continue;
    const later = mainIds.indexOf(edge.to);
    push(edge.to, later > index ? 'skip' : 'other');
  }
  if (extras.some((edge) => edge.to === CANCEL_STATE)) push(CANCEL_STATE, 'cancel');
  return sides;
}
