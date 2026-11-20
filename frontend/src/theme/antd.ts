// Forge 主题 → ant-design-vue design token 桥接。
// 色值的单一来源是 styles/_palette.scss（明色档）与 styles/tokens.scss 的暗色 mixin，
// 此处只做映射；scripts/check-antd-tokens.mjs 会校验这里没有引入 Forge 体系之外的颜色。
import { theme as antdTheme } from 'ant-design-vue';
import type { ThemeConfig } from 'ant-design-vue/es/config-provider/context';

const fontFamily =
  "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif";

// 品牌与状态语义色：明暗两套共用同一色相（Forge 固定 500 档）。
const semantic = {
  colorPrimary: '#da724d',
  colorInfo: '#4a90e2',
  colorSuccess: '#22a06b',
  colorWarning: '#d99a2b',
  colorError: '#f05b5b',
};

const shape = {
  borderRadius: 8,
};

// 弹层扁平化：弹窗容器不跟随全局圆角放大（全局 8 时 antd 会推导出 10），统一 4px
const components = {
  Modal: { borderRadiusLG: 4, borderRadiusSM: 4 },
};

export const forgeLightTheme: ThemeConfig = {
  algorithm: antdTheme.defaultAlgorithm,
  token: {
    ...semantic,
    ...shape,
    colorTextBase: '#202733',
    colorText: '#202733',
    colorTextSecondary: '#667085',
    colorTextTertiary: '#98a2b3',
    colorBgBase: '#ffffff',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    colorBgLayout: '#f8f9fb',
    colorBorder: '#d0d5dd',
    colorBorderSecondary: '#e5e7eb',
    fontFamily,
  },
  components,
};

export const forgeDarkTheme: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    ...semantic,
    ...shape,
    colorTextBase: '#eef1f5',
    colorText: '#eef1f5',
    colorTextSecondary: '#a8b0bd',
    colorTextTertiary: '#7a8595',
    colorBgBase: '#161b22',
    colorBgContainer: '#1c2230',
    colorBgElevated: '#1c2230',
    colorBgLayout: '#0f141b',
    colorBorder: '#2a313c',
    colorBorderSecondary: '#232933',
    fontFamily,
  },
  components,
};
