import { describe, it, expect, afterEach, vi } from 'vitest';
import { isMobileDevice } from '../src/lib/device';

/**
 * isMobileDevice（lib/device.ts）：场景作业（module.scenario）入口的门。
 * 桌面管理界面不显示该入口；手机/扫码枪浏览器（移动 UA 或 触屏+窄屏）显示。
 * 判据故意取宽松并集——现场设备形态太多，宁可多显示也不能漏。
 */

afterEach(() => {
  vi.unstubAllGlobals();
  // jsdom 默认视口宽度
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  // 撤掉用 defineProperty 盖在原型 getter 上的 UA 影子属性
  delete (window.navigator as unknown as { userAgent?: string }).userAgent;
});

describe('isMobileDevice：移动端专属入口的判定', () => {
  it('jsdom 默认（桌面 UA、无 matchMedia、宽屏）不算移动端', () => {
    expect(isMobileDevice()).toBe(false);
  });

  it('移动 UA（Android PDA / 扫码枪浏览器）直接算', () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Linux; Android 13; PDASK) Mobile Safari/537.36',
      configurable: true,
    });
    expect(isMobileDevice()).toBe(true);
  });

  it('桌面 UA + 触屏窄屏（iPad 伪装成桌面 UA 的形态）也认', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    Object.defineProperty(window, 'innerWidth', { value: 820, configurable: true });
    expect(isMobileDevice()).toBe(true);
  });

  it('桌面 UA + 触屏但大屏不算：大触摸屏一体机不是移动端', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
    expect(isMobileDevice()).toBe(false);
  });
});
