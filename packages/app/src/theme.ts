import type { ThemeConfig } from 'antd';

/**
 * 库位标签方向。表面走石墨，安全黄只做选中记号。
 * 数值与 app.css 的 :root 是同一套，改一边时改另一边。
 */
export const face = {
  ink: '#171717',
  paper: '#fafafa',
  card: '#ffffff',
  raised: '#f4f4f5',
  text: '#171717',
  text2: '#525252',
  text3: '#737373',
  line: 'rgba(23, 23, 23, 0.08)',
  lineStrong: 'rgba(23, 23, 23, 0.14)',
  amber: '#e6b325',
  amberInk: '#7a4e00',
  amberWash: '#f8f1dc',
  good: '#3f7d4e',
  bad: '#a33b32',
  sans: '"IBM Plex Sans", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, "Cascadia Mono", Consolas, monospace',
} as const;

export const ease = 'cubic-bezier(0.2, 0, 0, 1)';

export const appTheme: ThemeConfig = {
  token: {
    colorPrimary: face.ink,
    colorInfo: face.text2,
    colorSuccess: face.good,
    colorWarning: face.amberInk,
    colorError: face.bad,
    colorLink: face.ink,
    colorText: face.text,
    colorTextSecondary: face.text2,
    colorTextTertiary: face.text3,
    colorBgLayout: face.paper,
    colorBgContainer: face.card,
    colorBorder: face.lineStrong,
    colorBorderSecondary: face.line,
    fontFamily: face.sans,
    fontFamilyCode: face.mono,
    fontSize: 14,
    fontWeightStrong: 500,
    borderRadius: 8,
    borderRadiusLG: 12,
    borderRadiusSM: 6,
    controlHeight: 36,
    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)',
    boxShadowSecondary: '0 8px 24px rgba(0, 0, 0, 0.06)',
  },
  components: {
    Button: {
      primaryShadow: 'none',
      defaultShadow: 'none',
      dangerShadow: 'none',
      fontWeight: 500,
      paddingInline: 16,
    },
    Layout: {
      headerBg: face.card,
      bodyBg: face.paper,
      headerHeight: 56,
      headerPadding: '0 24px',
    },
    Table: {
      headerBg: face.paper,
      headerColor: face.text2,
      rowHoverBg: face.raised,
    },
  },
};
