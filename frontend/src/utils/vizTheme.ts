/**
 * 富内容渲染的统一视觉主题：Mermaid 图、Vega-Lite 图表共用一套与品牌橙协调的分类色板，
 * 代码块使用基于 tokyo-night 调整的深色主题。
 */
import type { EmbedOptions } from 'vega-embed';

/** 分类色板：首色为品牌橙，其余按色相拉开，保证相邻扇区/柱子可区分 */
export const VIZ_PALETTE = [
  '#da724d', // 品牌橙
  '#4c84d9', // 蓝
  '#489980', // 绿（与 --green 一致）
  '#e2a93b', // 琥珀
  '#8b6fd1', // 紫
  '#d9597a', // 玫红
  '#3fa7b5', // 青
  '#7a8699', // 石板灰
  '#b5835a', // 棕
  '#6aa84f', // 草绿
  '#c46bb0', // 品红
  '#5b6ee1', // 靛蓝
];

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const INK = '#292e38';
const MUTED = '#7a8699';

/** Mermaid base 主题变量（base 主题只接受十六进制颜色） */
export const MERMAID_THEME_VARIABLES: Record<string, string | boolean> = {
  fontFamily: FONT,
  fontSize: '14px',
  background: '#ffffff',
  // Mermaid 12 默认 neo 外观会用 primary→secondary 渐变描边（橙→蓝的双色边框），关掉保持单色
  useGradient: false,
  // 流程图节点 / 时序图参与者：浅橙底 + 品牌橙描边
  primaryColor: '#fdf0e9',
  primaryBorderColor: '#da724d',
  primaryTextColor: INK,
  secondaryColor: '#eaf1fb',
  secondaryBorderColor: '#4c84d9',
  secondaryTextColor: INK,
  tertiaryColor: '#e9f5f1',
  tertiaryBorderColor: '#489980',
  tertiaryTextColor: INK,
  lineColor: MUTED,
  textColor: INK,
  edgeLabelBackground: '#ffffff',
  clusterBkg: '#f8f9fb',
  clusterBorder: '#d8dfe7',
  noteBkgColor: '#fff6e0',
  noteBorderColor: '#e2a93b',
  noteTextColor: INK,
  // 时序图
  actorBkg: '#fdf0e9',
  actorBorder: '#da724d',
  actorTextColor: INK,
  actorLineColor: '#c3cad4',
  signalColor: '#58616f',
  signalTextColor: INK,
  activationBkgColor: '#fbe1d5',
  activationBorderColor: '#da724d',
  // 甘特图
  taskBkgColor: '#4c84d9',
  taskBorderColor: '#3b6fbf',
  taskTextColor: '#ffffff',
  activeTaskBkgColor: '#da724d',
  activeTaskBorderColor: '#bd5836',
  doneTaskBkgColor: '#9fd0bf',
  doneTaskBorderColor: '#489980',
  critBkgColor: '#d9597a',
  critBorderColor: '#b8405f',
  gridColor: '#e9ebef',
  sectionBkgColor: '#f8f9fb',
  altSectionBkgColor: '#ffffff',
  // 饼图
  ...Object.fromEntries(VIZ_PALETTE.map((color, i) => [`pie${i + 1}`, color])),
  pieStrokeColor: '#ffffff',
  pieStrokeWidth: '2px',
  pieOuterStrokeWidth: '0px',
  pieSectionTextColor: '#ffffff',
  pieSectionTextSize: '13px',
  pieTitleTextColor: INK,
  pieTitleTextSize: '17px',
  pieLegendTextColor: INK,
  pieLegendTextSize: '13px',
  pieOpacity: '1',
  // 象限图 / xychart 等其余图型沿用 base 主题按 primaryColor 推导
};

export const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: 'strict' as const,
  theme: 'base' as const,
  look: 'neo' as const,
  themeVariables: MERMAID_THEME_VARIABLES,
  // 默认 120px 就折行，中文短句也会被拆成两行；放宽到 220px
  flowchart: { wrappingWidth: 220 },
};

/** Vega-Lite 全局配置：品牌色板、统一字体与轻量坐标轴（模型给出的 spec.config 会覆盖这里） */
export const VEGA_CONFIG: Exclude<EmbedOptions['config'], string | undefined> = {
  background: 'transparent',
  font: FONT,
  range: { category: VIZ_PALETTE },
  mark: { color: VIZ_PALETTE[0] },
  view: { stroke: 'transparent' },
  title: { color: INK, fontSize: 15, fontWeight: 600, anchor: 'start', offset: 12 },
  axis: {
    labelColor: '#58616f',
    titleColor: '#58616f',
    labelFontSize: 11,
    titleFontSize: 12,
    titleFontWeight: 500,
    domainColor: '#d8dfe7',
    tickColor: '#d8dfe7',
    gridColor: '#eef1f5',
  },
  legend: { labelColor: '#58616f', titleColor: '#58616f', labelFontSize: 12, titleFontSize: 12 },
  arc: { stroke: '#ffffff', strokeWidth: 2 },
  bar: { cornerRadiusEnd: 3 },
  line: { strokeWidth: 2.5 },
  point: { filled: true, size: 60 },
};

/** 代码深色主题名（shiki 主题对象的 name） */
export const CODE_THEME = 'forge-dark';

/**
 * 基于 tokyo-night 生成深色代码主题：原版注释色在深色底上偏暗，提亮到可读；
 * 背景由外壳 CSS 提供（pre.shiki 背景透明），这里只用到前景配色。
 */
export async function loadCodeTheme() {
  const base = (await import('@shikijs/themes/tokyo-night')).default;
  const brighten: Record<string, string> = {
    '#51597d': '#7580a8',
    '#5a638c': '#7580a8',
    '#646e9c': '#8690b8',
  };
  return {
    ...base,
    name: CODE_THEME,
    tokenColors: (base.tokenColors ?? []).map((rule) => {
      const fg = rule.settings?.foreground?.toLowerCase();
      return fg && brighten[fg]
        ? { ...rule, settings: { ...rule.settings, foreground: brighten[fg] } }
        : rule;
    }),
  };
}
