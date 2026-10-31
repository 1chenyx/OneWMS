import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 运行期解析兜底：@one/core / @one/wms → 各自 dist（与 tsconfig paths 同一策略）。
 * 背景见 packages/wms/vitest.config.ts 注释（沙箱 junction 不可用）。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@one/core': fileURLToPath(new URL('../core/dist/index.js', import.meta.url)),
      '@one/wms': fileURLToPath(new URL('../wms/dist/index.js', import.meta.url)),
    },
  },
});
