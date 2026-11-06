import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 运行期解析兜底：@one/core → ../core/dist（与 tsconfig paths 同一策略，
 * 与 @one/wms 的 vitest.config.ts 同模式——沙箱 junction 重写问题的兜底）。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@one/core': fileURLToPath(new URL('../core/dist/index.js', import.meta.url)),
    },
  },
});
