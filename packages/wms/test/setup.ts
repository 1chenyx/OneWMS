import { expect } from 'vitest';
import { WmsDomain } from '../src/index.js';
import { releaseFlowGates } from './direct-ship.js';

/**
 * 既有用例测的是收货、上架、拣货和发货。
 * 质检、波次、打包、装车默认开着，这里先关掉，避免每条老用例都改一步。
 * 种子和这四步自己的用例不关。
 */
const orig = WmsDomain.prototype.workspace;
WmsDomain.prototype.workspace = function (this: WmsDomain, id: string) {
  const ws = orig.call(this, id);
  const path = expect.getState().testPath ?? '';
  if (path.includes('profile-seed') || path.includes('stage-flow')) return ws;
  releaseFlowGates(ws);
  return ws;
};
