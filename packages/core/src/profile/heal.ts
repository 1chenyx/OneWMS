import type { ConfigState, WorkflowDef, WorkflowTransition } from './profile-types.js';

/**
 * 折叠流程投影里的重复项。
 *
 * 每个节点启动时都会给同一批内置模块落 config.change，profileVersion 从 1
 * 各自往上数。同步之后全序是 (lamport, actor)，两条链被拼成一条：版本号
 * 碰巧接上的补丁都会再执行一次。模块安装补丁是「往 states / transitions
 * 末尾追加」，于是同一个状态 id 在投影里出现两次。
 *
 * 语义校验不允许状态 id 重复。投影已经脏了之后，下一次启动还会再装基础模块
 * （对端那次安装事件若没接上版本链，modules 段里就没有 core.wms），
 * applyDirect 对整份快照做校验，直接拒绝，进程起不来。
 *
 * 状态按 id 留第一次出现的那个——states[0] 仍然是初始态。
 * 转移按 from / to / when / effect / providedBy 留第一次；when 不同的边都保留。
 * 调用方拿返回值与入参比较引用，相同表示没改过。
 */
export function dedupeConfigState(state: ConfigState): ConfigState {
  let changed = false;
  const workflows: ConfigState['workflows'] = {};
  for (const [id, wf] of Object.entries(state.workflows)) {
    const deduped = dedupeWorkflow(wf);
    workflows[id] = deduped.workflow;
    if (deduped.changed) changed = true;
  }
  if (!changed) return state;
  return { ...state, workflows };
}

function dedupeWorkflow(wf: WorkflowDef): { workflow: WorkflowDef; changed: boolean } {
  const seenStates = new Set<string>();
  const states: WorkflowDef['states'] = [];
  let changed = false;
  for (const st of wf.states) {
    if (typeof st?.id === 'string' && seenStates.has(st.id)) {
      changed = true;
      continue;
    }
    if (typeof st?.id === 'string') seenStates.add(st.id);
    states.push(st);
  }

  const seenEdges = new Set<string>();
  const transitions: WorkflowTransition[] = [];
  for (const tr of wf.transitions) {
    const key = `${tr.from}\0${tr.to}\0${tr.when ?? ''}\0${tr.effect ?? ''}\0${tr.providedBy ?? ''}`;
    if (seenEdges.has(key)) {
      changed = true;
      continue;
    }
    seenEdges.add(key);
    transitions.push(tr);
  }

  if (!changed) return { workflow: wf, changed: false };
  return { workflow: { ...wf, states, transitions }, changed: true };
}
