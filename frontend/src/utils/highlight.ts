/**
 * Shiki 懒加载高亮：首次遇到代码块才初始化引擎，每种语言按需加载语法包。
 * 使用 JS 正则引擎，避免 WASM 资源；未识别的语言一律回退为纯文本。
 */
import type { HighlighterCore } from 'shiki/core';
import DOMPurify from 'dompurify';

const SUPPORTED: Record<string, () => Promise<unknown>> = {
  javascript: () => import('@shikijs/langs/javascript'),
  typescript: () => import('@shikijs/langs/typescript'),
  jsx: () => import('@shikijs/langs/jsx'),
  tsx: () => import('@shikijs/langs/tsx'),
  json: () => import('@shikijs/langs/json'),
  python: () => import('@shikijs/langs/python'),
  bash: () => import('@shikijs/langs/bash'),
  yaml: () => import('@shikijs/langs/yaml'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  vue: () => import('@shikijs/langs/vue'),
  sql: () => import('@shikijs/langs/sql'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  java: () => import('@shikijs/langs/java'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  diff: () => import('@shikijs/langs/diff'),
  markdown: () => import('@shikijs/langs/markdown'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  graphql: () => import('@shikijs/langs/graphql'),
  toml: () => import('@shikijs/langs/toml'),
  ini: () => import('@shikijs/langs/ini'),
  xml: () => import('@shikijs/langs/xml'),
  php: () => import('@shikijs/langs/php'),
  ruby: () => import('@shikijs/langs/ruby'),
  swift: () => import('@shikijs/langs/swift'),
  kotlin: () => import('@shikijs/langs/kotlin'),
};

const ALIASES: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
  cs: 'csharp',
  'c#': 'csharp',
  docker: 'dockerfile',
  gql: 'graphql',
  golang: 'go',
  kt: 'kotlin',
  rb: 'ruby',
  rs: 'rust',
  'objective-c': 'c',
};

/** 归一化语言名；不在白名单（或纯文本类）时返回空串表示按纯文本渲染 */
export function normalizeLang(lang: string): string {
  const key = lang.trim().toLowerCase();
  if (!key) return '';
  const mapped = ALIASES[key] ?? key;
  return mapped in SUPPORTED ? mapped : '';
}

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLangs = new Set<string>();

function getHighlighter(): Promise<HighlighterCore> {
  // shiki 内核与 JS 正则引擎也按需加载，首屏包不包含任何高亮代码
  if (!highlighterPromise)
    highlighterPromise = Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(
      ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
        createHighlighterCore({
          themes: [import('@shikijs/themes/github-light')],
          langs: [],
          engine: createJavaScriptRegexEngine(),
        }),
    );
  highlighterPromise.catch(() => {
    highlighterPromise = null; // 加载失败（如网络中断）允许下次重试
  });
  return highlighterPromise;
}

/** 高亮为带内联样式的 HTML；输出经 DOMPurify 消毒（保留 shiki 生成的 style 配色） */
export async function highlightCode(code: string, rawLang: string): Promise<string> {
  const highlighter = await getHighlighter();
  // 自身再归一化一次：别名（ts/py…）映射到语言包名，白名单外按纯文本（shiki 内置 text）
  const lang = normalizeLang(rawLang) || 'text';
  if (lang !== 'text' && !loadedLangs.has(lang)) {
    await highlighter.loadLanguage(SUPPORTED[lang] as never);
    loadedLangs.add(lang);
  }
  const html = highlighter.codeToHtml(code, { lang, theme: 'github-light' });
  return DOMPurify.sanitize(html, { ADD_ATTR: ['style', 'tabindex'] });
}
