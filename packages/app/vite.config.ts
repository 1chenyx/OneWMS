import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * - alias @one/core → 兄弟包 src：仅供 import type（编译期擦除，不进 bundle）。
 *   误引运行时值会在构建期立即报错（core 的 better-sqlite3/node: 内置模块无法打包）
 *   ——这是「前端只共享类型、不共享运行时」的天然护栏。
 * - dev 代理 /api → 本地 one-server（3000），零 CORS。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: '@one/wms/numbering',
        replacement: fileURLToPath(new URL('../wms/src/numbering/pattern.ts', import.meta.url)),
      },
      {
        find: '@one/core/when',
        replacement: fileURLToPath(new URL('../core/src/profile/when.ts', import.meta.url)),
      },
      {
        find: '@one/core',
        replacement: fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      },
    ],
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    // jsdom + AntD 交互测试在本机较慢（冻结弹窗等多步 userEvent 单测约 40s，
    // 全仓并行跑时更甚）——统一放宽超时，避免环境慢误报为失败
    testTimeout: 90000,
  },
});
