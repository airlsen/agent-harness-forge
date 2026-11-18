/**
 * 富内容渲染的统一视觉主题：Mermaid 图、Vega-Lite 图表共用一套与品牌橙协调的分类色板，
 * 代码块使用基于 tokyo-night 调整的深色主题。
 */
import type { EmbedOptions } from 'vega-embed';

/**
 * 分类色板（低饱和协调色板）：统一降低饱和度、拉平亮度，与界面的石板蓝灰底色呼应；
 * 冷暖交替排列，相邻扇区/柱子易区分；末位石板灰留给"其他"。
 */
export const VIZ_PALETTE = [
  '#c8704f', // 陶土橙（品牌色降饱和）
  '#5b7c99', // 雾蓝（与界面蓝灰同一色系）
  '#7fa087', // 鼠尾草绿
  '#d1a35e', // 赭石
  '#8a7aa8', // 灰紫
  '#5e9c9a', // 灰青
  '#b8797f', // 豆沙粉
  '#8c96a3', // 石板灰（其他）
];

/** 单系列图表默认用雾蓝，品牌橙留作强调色 */
export const VIZ_SINGLE = VIZ_PALETTE[1];

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const INK = '#292e38';
const MUTED = '#8c96a3';

/** Mermaid base 主题变量（base 主题只接受十六进制颜色） */
export const MERMAID_THEME_VARIABLES: Record<string, string | boolean> = {
  fontFamily: FONT,
  fontSize: '14px',
  background: '#ffffff',
  // Mermaid 12 默认 neo 外观会用 primary→secondary 渐变描边（橙→蓝的双色边框），关掉保持单色
  useGradient: false,
  // 流程图节点：雾蓝浅底 + 雾蓝描边，整图不再大面积铺品牌橙
  primaryColor: '#eef3f7',
  primaryBorderColor: '#8fa6bb',
  primaryTextColor: INK,
  secondaryColor: '#f8eee9',
  secondaryBorderColor: '#c8704f',
  secondaryTextColor: INK,
  tertiaryColor: '#eff4f0',
  tertiaryBorderColor: '#7fa087',
  tertiaryTextColor: INK,
  lineColor: MUTED,
  textColor: INK,
  edgeLabelBackground: '#ffffff',
  clusterBkg: '#f8f9fb',
  clusterBorder: '#d8dfe7',
  noteBkgColor: '#faf4ea',
  noteBorderColor: '#d1a35e',
  noteTextColor: INK,
  // 时序图
  actorBkg: '#eef3f7',
  actorBorder: '#8fa6bb',
  actorTextColor: INK,
  actorLineColor: '#c9d2de',
  signalColor: '#58616f',
  signalTextColor: INK,
  activationBkgColor: '#f8eee9',
  activationBorderColor: '#c8704f',
  // 甘特图
  taskBkgColor: '#5b7c99',
  taskBorderColor: '#4a6884',
  taskTextColor: '#ffffff',
  activeTaskBkgColor: '#c8704f',
  activeTaskBorderColor: '#a95b3e',
  doneTaskBkgColor: '#b9cdbe',
  doneTaskBorderColor: '#7fa087',
  critBkgColor: '#b8797f',
  critBorderColor: '#9a5f65',
  gridColor: '#e9ebef',
  sectionBkgColor: '#f8f9fb',
  altSectionBkgColor: '#ffffff',
  // 饼图
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`pie${i + 1}`, VIZ_PALETTE[i % VIZ_PALETTE.length]]),
  ),
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
  mark: { color: VIZ_SINGLE },
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
