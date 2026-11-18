/**
 * 富内容渲染的统一视觉主题：
 * - Mermaid 流程图 / 时序图沿用界面主题色（品牌珊瑚橙浅底 + 橙色描边）；
 * - 饼图、柱状图、折线图等数据图表使用围绕品牌珊瑚橙的清透亮色板；
 * - 代码块使用基于 tokyo-night 调整的深色主题。
 */
import type { EmbedOptions } from 'vega-embed';

/**
 * 数据图表分类色板：以品牌珊瑚橙为首，其余为高明度、中高饱和的清透色（马卡龙但不发灰），
 * 冷暖交替排列，相邻扇区/柱子易区分；末位浅石板灰留给"其他"。
 */
export const VIZ_PALETTE = [
  '#f28c64', // 珊瑚橙（品牌色提亮）
  '#6cb4f4', // 天空蓝
  '#5fcfaa', // 薄荷绿
  '#f9c45c', // 芒果黄
  '#a993f0', // 薰衣草紫
  '#f589a8', // 蜜桃粉
  '#4fc4d6', // 湖水青
  '#c5ccd6', // 浅石板灰（其他）
];

/** 单系列图表默认用品牌珊瑚橙，与界面主题一致 */
export const VIZ_SINGLE = VIZ_PALETTE[0];

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const INK = '#292e38';
const MUTED = '#7a8699';

/** Mermaid base 主题变量（base 主题只接受十六进制颜色） */
export const MERMAID_THEME_VARIABLES: Record<string, string | boolean | Record<string, string>> = {
  fontFamily: FONT,
  fontSize: '14px',
  background: '#ffffff',
  // Mermaid 12 默认 neo 外观会用 primary→secondary 渐变描边（橙→蓝的双色边框），关掉保持单色
  useGradient: false,
  // 流程图节点 / 时序图参与者：界面主题色——浅橙底 + 品牌橙描边
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
  // 甘特图：数据图表色板的清透色，深色文字保证可读
  taskBkgColor: '#9fcdf8',
  taskBorderColor: '#6cb4f4',
  taskTextColor: INK,
  taskTextOutsideColor: INK,
  taskTextLightColor: INK,
  taskTextDarkColor: INK,
  activeTaskBkgColor: '#f8b294',
  activeTaskBorderColor: '#f28c64',
  doneTaskBkgColor: '#a6e6d0',
  doneTaskBorderColor: '#5fcfaa',
  critBkgColor: '#f9b3c7',
  critBorderColor: '#f589a8',
  gridColor: '#e9ebef',
  sectionBkgColor: '#f8f9fb',
  altSectionBkgColor: '#ffffff',
  // 饼图：清透色板 + 白色分隔，扇区文字用深色（浅色扇区上白字看不清）
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`pie${i + 1}`, VIZ_PALETTE[i % VIZ_PALETTE.length]]),
  ),
  pieStrokeColor: '#ffffff',
  pieStrokeWidth: '2px',
  pieOuterStrokeWidth: '0px',
  pieSectionTextColor: INK,
  pieSectionTextSize: '13px',
  pieTitleTextColor: INK,
  pieTitleTextSize: '17px',
  pieLegendTextColor: INK,
  pieLegendTextSize: '13px',
  pieOpacity: '1',
  // Mermaid 内置柱状/折线图（xychart）与数据图表共用色板
  xyChart: {
    backgroundColor: '#ffffff',
    plotColorPalette: VIZ_PALETTE.join(', '),
    titleColor: INK,
    xAxisLabelColor: '#58616f',
    yAxisLabelColor: '#58616f',
    xAxisTitleColor: '#58616f',
    yAxisTitleColor: '#58616f',
    xAxisLineColor: '#d8dfe7',
    yAxisLineColor: '#d8dfe7',
    xAxisTickColor: '#d8dfe7',
    yAxisTickColor: '#d8dfe7',
  },
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

/** Vega-Lite 全局配置：清透色板、统一字体与轻量坐标轴（模型给出的 spec.config 会覆盖这里） */
export const VEGA_CONFIG: Exclude<EmbedOptions['config'], string | undefined> = {
  background: 'transparent',
  font: FONT,
  range: { category: VIZ_PALETTE },
  mark: { color: VIZ_SINGLE },
  view: { stroke: 'transparent' },
  title: { color: INK, fontSize: 15, fontWeight: 600, anchor: 'start', offset: 12 },
  axis: {
    labelColor: '#58616f',
    titleColor: '#58616f',
    labelFontSize: 11,
    titleFontSize: 12,
    titleFontWeight: 500,
    domainColor: '#e3e7ed',
    tickColor: '#e3e7ed',
    gridColor: '#f1f3f6',
  },
  legend: {
    labelColor: '#58616f',
    titleColor: '#58616f',
    labelFontSize: 12,
    titleFontSize: 12,
    symbolType: 'circle',
  },
  arc: { stroke: '#ffffff', strokeWidth: 2 },
  bar: { cornerRadiusEnd: 4 },
  line: { strokeWidth: 2.5 },
  // 面积图半透明填充，叠加多系列时依然清爽
  area: { fillOpacity: 0.45, line: true },
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
