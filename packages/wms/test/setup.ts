import { expect } from 'vitest';
import { WmsDomain } from '../src/index.js';
import { releaseFlowGates } from './direct-ship.js';

/**
 * 既有用例测的是收货、上架、拣货和发货。
 * 质检、波次、打包、装车默认开着，这里先关掉，避免每条老用例都改一步。
 * 种子、阶段流程和组波自己的用例不关。
 * 每次 workspace() 都会再关一次（工具调用会重新取工作区），所以要测组波的文件必须整份跳过。
 */
const orig = WmsDomain.prototype.workspace;
WmsDomain.prototype.workspace = function (this: WmsDomain, id: string) {
  const ws = orig.call(this, id);
  const path = expect.getState().testPath ?? '';
  if (path.includes('profile-seed') || path.includes('stage-flow') || path.includes('wave-batch')) return ws;
  releaseFlowGates(ws);
  return ws;
};
