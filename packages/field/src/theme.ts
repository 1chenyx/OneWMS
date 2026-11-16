/**
 * 现场端色值。抄桌面 face 的数字，不抽公共包，也不引入 antd。
 * 安全黄只做选中标记。
 */
export const face = {
  ink: '#171717',
  paper: '#fafafa',
  card: '#ffffff',
  text: '#171717',
  text2: '#525252',
  amber: '#e6b325',
  good: '#3f7d4e',
  bad: '#a33b32',
  sans: '"IBM Plex Sans", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, "Cascadia Mono", Consolas, monospace',
} as const;

export const hit = {
  target: 56,
  primary: 64,
  body: 18,
  meta: 16,
  code: 22,
} as const;
