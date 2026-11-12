import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OneCore } from '@one/core';
import { WmsDomain } from '../src/index.js';

/**
 * 连上另一个节点并同步之后再重启。
 *
 * 两边启动时各自给同一批模块落过 config.change。同步把两条版本链按
 * (lamport, actor) 拼成一条，同一状态会被追加两次；对端那次「登记 core.wms」
 * 的事件如果没接上版本号，投影里就没有这个模块。下次启动要补装它，
 * applyDirect 校验整份快照，看到重复状态就拒绝，桌面壳等不到端口，应用起不来。
 */

const WS = 'default';

describe('同步后重启', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'one-wms-sync-restart-'));
    dbPath = join(dir, 'onewms.db');
    const core = OneCore.open(dbPath);
    WmsDomain.attach(core).workspace(WS);
    core.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('流程状态重复且基础模块登记丢失时，重开仍能启动并折叠重复项', () => {
    const prep = OneCore.open(dbPath);
    const db = prep.exposeDb();
    const row = db
      .prepare<[string], { workflows: string; modules: string }>(
        'SELECT workflows, modules FROM profile_state WHERE workspace_id = ?',
      )
      .get(WS)!;
    const workflows = JSON.parse(row.workflows) as {
      inbound: { states: Array<{ id: string; label: string }>; transitions: Array<{ from: string; to: string }> };
      outbound: { states: Array<{ id: string; label: string }>; transitions: Array<{ from: string; to: string }> };
    };
    workflows.inbound.states.push({ ...workflows.inbound.states[1] });
    workflows.outbound.states.push({ ...workflows.outbound.states[1] });
    workflows.inbound.transitions.push({ ...workflows.inbound.transitions[0] });
    const modules = JSON.parse(row.modules) as Record<string, unknown>;
    delete modules['core.wms'];
    db.prepare('UPDATE profile_state SET workflows = ?, modules = ? WHERE workspace_id = ?').run(
      JSON.stringify(workflows),
      JSON.stringify(modules),
      WS,
    );
    prep.close();

    const core = OneCore.open(dbPath);
    try {
      const ws = WmsDomain.attach(core).workspace(WS);
      const snap = ws.profile.getSnapshot();
      for (const wf of Object.values(snap.workflows)) {
        const ids = wf.states.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
      expect(snap.modules['core.wms']?.version).toBe('0.1.0');

      const stored = core
        .exposeDb()
        .prepare<[string], { workflows: string }>('SELECT workflows FROM profile_state WHERE workspace_id = ?')
        .get(WS)!;
      const persisted = JSON.parse(stored.workflows) as typeof workflows;
      expect(persisted.inbound.states.filter((s) => s.id === workflows.inbound.states[1].id)).toHaveLength(1);
    } finally {
      core.close();
    }
  });
});
