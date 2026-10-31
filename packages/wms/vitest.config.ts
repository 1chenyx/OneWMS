import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 运行期解析兜底：@one/core → ../core/dist（与 tsconfig paths 同一策略）。
 *
 * 背景：当前命令执行沙箱会把 node_modules 里 workspace junction 的目标
 * 重写为单命令私有缓存路径（命令结束即失效），链接不可用；改由
 * alias/paths 直接指向 dist 实体文件。非沙箱环境下 npm 原生链接可用，
 * 此配置与之共存无冲突。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@one/core': fileURLToPath(new URL('../core/dist/index.js', import.meta.url)),
    },
  },
});
