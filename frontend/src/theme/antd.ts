// Forge 主题 → ant-design-vue design token 桥接。
// 色值的单一来源是 styles/：品牌色来自当前主题（styles/themes/，经 theme-export.module.scss 导出），
// 中性与状态色来自 _palette.scss（明色档）与 tokens.scss 的暗色 mixin。
// 此处只做映射；scripts/check-antd-tokens.mjs 会校验这里没有引入 Forge 体系之外的颜色。
import { theme as antdTheme } from 'ant-design-vue';
import type { ThemeConfig } from 'ant-design-vue/es/config-provider/context';
import themeColors from '../styles/theme-export.module.scss';

const fontFamily =
  "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif";

// 品牌与状态语义色：明暗两套共用同一色相。主色取当前主题的 antd 色阶，状态色固定 500 档。
const semantic = {
  colorPrimary: themeColors.antdPrimary,
  colorInfo: '#4a90e2',
  colorSuccess: '#22a06b',
  colorWarning: '#d99a2b',
  colorError: '#f05b5b',
};

const shape = {
  borderRadius: 8,
};

// 按钮去掉 antd 自带的 `0 2px 0` 底部阴影（默认 / 虚线 / 主按钮 / 危险主按钮）。
// 只在 Button 组件内覆盖：输入框、下拉框的聚焦光圈同样使用 controlOutline，不能改全局 token。
// ant-design-vue 4 的 OverrideToken 把每个组件键都声明为必填，只覆盖 Button 时需断言类型。
const components = {
  Button: {
    controlOutline: 'transparent',
    controlTmpOutline: 'transparent',
    colorErrorOutline: 'transparent',
  },
} as ThemeConfig['components'];

export const forgeLightTheme: ThemeConfig = {
  algorithm: antdTheme.defaultAlgorithm,
  components,
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
};

export const forgeDarkTheme: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  components,
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
};
