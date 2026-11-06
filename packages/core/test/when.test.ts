import { describe, it, expect } from 'vitest';
import { evalWhenCondition, ModuleConfig } from '../src/index.js';

const modules: Record<string, ModuleConfig> = {
  'module.putaway': { enabled: true, version: '0.1.0' },
  'module.expiry': { enabled: false, version: '0.1.0' },
};

describe('when 条件运行时求值（evalWhenCondition）', () => {
  it('undefined / 空串 → 无条件成立', () => {
    expect(evalWhenCondition(undefined, modules)).toBe(true);
    expect(evalWhenCondition('', modules)).toBe(true);
    expect(evalWhenCondition('   ', modules)).toBe(true);
  });

  it('module.{id}.enabled：已装且启用 → true', () => {
    expect(evalWhenCondition('module.putaway.enabled', modules)).toBe(true);
  });

  it('module.{id}.enabled：已装但停用 → false', () => {
    expect(evalWhenCondition('module.expiry.enabled', modules)).toBe(false);
  });

  it('module.{id}.enabled：未安装 → false（可选链语义）', () => {
    expect(evalWhenCondition('module.absent.enabled', modules)).toBe(false);
  });

  it('! 取反：停用模块取反 → true；启用模块取反 → false；未装取反 → true', () => {
    expect(evalWhenCondition('!module.expiry.enabled', modules)).toBe(true);
    expect(evalWhenCondition('!module.putaway.enabled', modules)).toBe(false);
    expect(evalWhenCondition('!module.absent.enabled', modules)).toBe(true);
  });

  it('无法识别的模式保守返回 false（脏配置不放行）', () => {
    expect(evalWhenCondition('roles.admin.enabled', modules)).toBe(false);
    expect(evalWhenCondition('module.x.y.z', modules)).toBe(false);
    expect(evalWhenCondition('anything else', modules)).toBe(false);
  });
});
