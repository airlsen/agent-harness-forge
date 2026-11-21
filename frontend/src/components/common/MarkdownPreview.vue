<script setup lang="ts">
/**
 * MarkdownPreview — 公共 Markdown 文档预览（默认黄色主题 · highlight.js 版）
 * 特性：GFM/换行/代码高亮(hl.js)/表格/引用/任务列表/链接/图片/数学占位/Mermaid/Vega/流式光标/行号
 * 放置：frontend/src/components/common，与 JsonPreview 同级公共组件
 *
 * 用法：
 * <MarkdownPreview :content="md" streaming show-line-numbers enable-mermaid />
 * <MarkdownPreview :content="md" accent="indigo" theme="dark" />
 */
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { Marked, Renderer, type Token, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import 'highlight.js/styles/atom-one-dark.css';
import CodeBlock from '../CodeBlock.vue';
import MermaidBlock from '../MermaidBlock.vue';
import ChartBlock from '../ChartBlock.vue';
import { useCopy } from '../../utils/useCopy';

interface Props {
  content: string;
  streaming?: boolean;
  enableMath?: boolean;
  enableMermaid?: boolean;
  showLineNumbers?: boolean;
  maxHeight?: string;
  theme?: 'light' | 'dark' | 'auto';
  accent?: 'brand' | 'yellow' | 'indigo';
  compact?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  streaming: false,
  enableMath: true,
  enableMermaid: true,
  showLineNumbers: false,
  maxHeight: '',
  theme: 'auto',
  accent: 'brand',
  compact: false,
});

const contentRef = ref<HTMLElement>();
const renderedContent = ref('');
const mermaidCodes = ref<string[]>([]);
const vegaCodes = ref<string[]>([]);

const { copy: copyText } = useCopy();

// 解析配置仅作用于当前预览，不污染聊天等其他 Markdown 渲染器。
// 代码高亮由下方自定义 renderer.code 负责。
const markdownParser = new Marked({
  breaks: true,
  gfm: true,
  pedantic: false,
});

const langDisplayName = (lang: string) => {
  const map: Record<string, string> = {
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    python: 'Python',
    java: 'Java',
    csharp: 'C#',
    cpp: 'C++',
    c: 'C',
    php: 'PHP',
    ruby: 'Ruby',
    go: 'Go',
    rust: 'Rust',
    swift: 'Swift',
    kotlin: 'Kotlin',
    html: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    json: 'JSON',
    yaml: 'YAML',
    sql: 'SQL',
    bash: 'Bash',
    shell: 'Shell',
    dockerfile: 'Docker',
    markdown: 'Markdown',
    vue: 'Vue',
    plaintext: 'Text',
    text: 'Text',
  };
  return map[lang] || lang.toUpperCase();
};

const codeStats = (code: string) => {
  const lines = code.split('\n').length;
  const chars = code.length;
  return `${lines} 行 · ${chars} 字符`;
};

const generateLineNumbers = (code: string) =>
  code
    .split('\n')
    .map((_, i) => String(i + 1))
    .join('\n');

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 判断语言是否被 hljs 支持（用于归一化） */
const normalizeHljsLang = (raw: string): string => {
  const key = raw.trim().toLowerCase();
  if (!key) return '';
  // 别名归一
  const aliases: Record<string, string> = {
    js: 'javascript',
    ts: 'typescript',
    py: 'python',
    sh: 'bash',
    shell: 'bash',
    yml: 'yaml',
    md: 'markdown',
    vue: 'vue',
    html: 'xml',
  };
  const mapped = aliases[key] ?? key;
  return hljs.getLanguage(mapped) ? mapped : '';
};

const processMath = (content: string) => {
  if (!props.enableMath) return content;
  content = content.replace(/\$\$([\s\S]+?)\$\$/g, (_m: string, expr: string) => {
    const safe = escapeHtml(expr.trim());
    return `<div class="math-block"><span class="math-katex">${safe}</span></div>`;
  });
  content = content.replace(/\$([^$\n]+?)\$/g, (_m: string, expr: string) => {
    const safe = escapeHtml(expr.trim());
    return `<span class="math-inline">${safe}</span>`;
  });
  return content;
};

const ensureCompleteCodeBlocks = (content: string) =>
  content.replace(/```(\w*)\n([\s\S]*?)(?:```|$)/g, (match: string, lang: string, code: string) => {
    if (!match.endsWith('```')) return `\`\`\`${lang}\n${code}\n… 正在生成\n\`\`\``;
    return match;
  });

/**
 * highlight.js 渲染后处理：
 * 代码块已由自定义 renderer 高亮；这里只处理极少数未闭合/异常块。
 */
const postProcessHljs = (html: string) => {
  const temp = document.createElement('div');
  temp.innerHTML = html;
  // 为异常块补充 hljs 类。
  for (const pre of Array.from(temp.querySelectorAll<HTMLPreElement>('pre.md-code-pre'))) {
    if (!pre.querySelector('code.hljs')) {
      const codeEl = pre.querySelector('code');
      const raw = pre.getAttribute('data-code') || codeEl?.textContent || '';
      const langRaw = pre.getAttribute('data-lang') || '';
      const lang = normalizeHljsLang(langRaw);
      let highlighted = '';
      if (lang && hljs.getLanguage(lang)) {
        try {
          highlighted = hljs.highlight(raw, { language: lang }).value;
        } catch {
          highlighted = escapeHtml(raw);
        }
      } else if (raw) {
        try {
          highlighted = hljs.highlightAuto(raw).value;
        } catch {
          highlighted = escapeHtml(raw);
        }
      }
      if (codeEl) {
        codeEl.innerHTML = highlighted;
        codeEl.classList.add('hljs');
        if (lang) codeEl.classList.add(`language-${lang}`);
      }
    }
  }
  return temp.innerHTML;
};

const buildRenderer = () => {
  const renderer = new Renderer();

  // code: marked v15 token object — 用 highlight.js 高亮
  renderer.code = (token: Tokens.Code) => {
    const code = token.text || '';
    const langRaw = token.lang || '';
    const hlLang = normalizeHljsLang(langRaw);
    const validLang = hlLang || (langRaw ? langRaw.toLowerCase() : 'text');
    const display = langDisplayName(validLang);
    const stats = codeStats(code);
    const id = `md-code-${Math.random().toString(36).slice(2, 8)}`;
    const lineNums = props.showLineNumbers
      ? `<div class="line-numbers">${escapeHtml(generateLineNumbers(code))}</div>`
      : '';

    // 直接用 hljs 高亮（与 markedHighlight 配置保持一致，黄色主题外壳）
    let highlighted = '';
    if (hlLang && hljs.getLanguage(hlLang)) {
      try {
        highlighted = hljs.highlight(code, { language: hlLang }).value;
      } catch {
        highlighted = escapeHtml(code);
      }
    } else {
      try {
        highlighted = hljs.highlightAuto(code).value;
      } catch {
        highlighted = escapeHtml(code);
      }
    }

    return `
      <div class="md-code-block" data-language="${escapeHtml(validLang)}" data-block-id="${id}">
        <div class="md-code-header">
          <div class="md-code-info">
            <span class="md-lang-tag">${escapeHtml(display)}</span>
            <span class="md-code-stats">${escapeHtml(stats)}</span>
          </div>
          <div class="md-code-actions">
            <button class="md-action-btn md-copy-btn" data-copy-id="${id}" title="复制代码" type="button">
              <span class="md-icon copy-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></span><span class="md-icon check-icon" style="display:none"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>
              <span class="md-btn-text">复制</span>
            </button>
            <button class="md-action-btn md-expand-btn" data-expand-id="${id}" title="展开/收起" type="button"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 15 5 5 5-5"></path><path d="m7 9 5-5 5 5"></path></svg></button>
          </div>
        </div>
        <div class="md-code-content" id="wrap-${id}">
          ${lineNums}
          <pre class="md-code-pre hljs-pre" id="${id}" data-code="${escapeHtml(code)}" data-lang="${escapeHtml(validLang)}"><code class="hljs language-${escapeHtml(validLang)}">${highlighted}</code></pre>
        </div>
      </div>
    `;
  };

  renderer.table = function (this: Renderer, token: Tokens.Table) {
    let fallback = '';
    try {
      fallback = Renderer.prototype.table.call(this, token);
    } catch {
      let header = '';
      for (const cell of token.header) {
        const content = markdownParser.parseInline(cell.text) || cell.text;
        const align = cell.align ? ` align="${cell.align}"` : '';
        header += `<th${align}>${content}</th>\n`;
      }
      let body = '';
      for (const row of token.rows) {
        let rowHtml = '';
        for (const cell of row) {
          const content = markdownParser.parseInline(cell.text) || cell.text;
          const align = cell.align ? ` align="${cell.align}"` : '';
          rowHtml += `<td${align}>${content}</td>\n`;
        }
        body += `<tr>\n${rowHtml}</tr>\n`;
      }
      fallback = `<table>\n<thead>\n<tr>\n${header}</tr>\n</thead>\n<tbody>\n${body}</tbody>\n</table>\n`;
    }
    const id = `md-table-${Math.random().toString(36).slice(2, 6)}`;
    const tableHtml = (fallback as string).replace('<table>', '<table class="md-table">');
    return `
      <div class="md-table-wrapper" id="${id}">
        <div class="md-table-header">
          <div class="md-table-info"><span class="md-table-icon">▦</span><span class="md-table-label">数据表格</span></div>
          <div class="md-table-actions"><button class="md-action-btn md-scroll-btn" data-table="${id}" title="水平滚动" type="button">⇄</button></div>
        </div>
        <div class="md-table-container">${tableHtml}</div>
      </div>
    `;
  };

  renderer.link = (token: Tokens.Link) => {
    const href = token.href || '';
    const title = token.title || '';
    const text = token.text || '';
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    const isExternal = /^https?:\/\//.test(href) || href.startsWith('//');
    const isEmail = href.startsWith('mailto:');
    const isFile = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar)$/i.test(href);
    let cls = 'md-link';
    let icon = '';
    let attrs = '';
    if (isExternal) {
      cls += ' is-external';
      icon = `<span class="md-link-icon"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg></span>`;
      attrs = ' target="_blank" rel="noopener noreferrer" data-external="true"';
    } else if (isEmail) {
      cls += ' is-email';
      icon = `<span class="md-link-icon"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"></rect><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"></path></svg></span>`;
    } else if (isFile) {
      cls += ' is-file';
      icon = `<span class="md-link-icon"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg></span>`;
      attrs = ' target="_blank" rel="noopener noreferrer"';
    }
    return `<a href="${escapeHtml(href)}"${titleAttr}${attrs} class="${cls}">${text}${icon}</a>`;
  };

  renderer.listitem = (token: Tokens.ListItem) => {
    const t = token as Tokens.ListItem & { task?: boolean; checked?: boolean };
    if (t.task) {
      const checked = t.checked ? 'checked' : '';
      const cls = t.checked ? 'checked' : '';
      const text = t.text || markdownParser.parser(t.tokens as Token[]);
      return `<li class="md-list-item md-task-item ${cls}"><input type="checkbox" ${checked} disabled class="md-task-checkbox"><span class="md-task-text">${text}</span></li>`;
    }
    const text = (t as unknown as { text: string }).text || markdownParser.parser(t.tokens as Token[]);
    return `<li class="md-list-item">${text}</li>`;
  };

  renderer.blockquote = (token: Tokens.Blockquote) => {
    const quote = markdownParser.parser(token.tokens as Token[]);
    let type = 'default';
    let icon = '';
    const lower = quote.toLowerCase();
    if (lower.includes('note') || lower.includes('[!note]')) {
      type = 'note';
      icon =
        '<span class="md-quote-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg></span>';
    } else if (lower.includes('warning') || lower.includes('[!warning]')) {
      type = 'warning';
      icon =
        '<span class="md-quote-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg></span>';
    } else if (lower.includes('tip') || lower.includes('[!tip]')) {
      type = 'tip';
      icon =
        '<span class="md-quote-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"></path><path d="M9 18h6"></path><path d="M10 22h4"></path></svg></span>';
    } else if (lower.includes('error') || lower.includes('[!error]')) {
      type = 'error';
      icon =
        '<span class="md-quote-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg></span>';
    } else if (lower.includes('info') || lower.includes('[!info]')) {
      type = 'info';
      icon =
        '<span class="md-quote-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg></span>';
    }
    return `<blockquote class="md-quote md-quote-${type}">${icon}<div class="md-quote-content">${quote}</div></blockquote>`;
  };

  renderer.heading = (token: Tokens.Heading) => {
    const depth = token.depth;
    const text = token.text || markdownParser.parser(token.tokens as Token[]);
    const id = text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
      .slice(0, 64);
    return `<h${depth} id="${id}" class="md-heading md-h${depth}">${text}<a href="#${id}" class="md-anchor" aria-hidden="true">#</a></h${depth}>`;
  };

  return renderer;
};

const renderMarkdown = async (raw: string) => {
  let content = raw || '';
  if (props.streaming) content = ensureCompleteCodeBlocks(content);
  content = processMath(content);

  const mermaidStore: string[] = [];
  const vegaStore: string[] = [];
  content = content.replace(/```mermaid\n([\s\S]*?)\n```/g, (_m: string, code: string) => {
    const i = mermaidStore.push(code.trim()) - 1;
    return `<!--mermaid:${i}:mermaid-->`;
  });
  content = content.replace(
    /```(?:vega|vega-lite|vegalite|chart)\n([\s\S]*?)\n```/g,
    (_m: string, code: string) => {
      const i = vegaStore.push(code.trim()) - 1;
      return `<!--vega:${i}:vega-->`;
    },
  );

  const renderer = buildRenderer();
  let html = markdownParser.parse(content, { renderer }) as string;

  html = html.replace(/<!--mermaid:(\d+):mermaid-->/g, (_m: string, idx: string) => {
    const code = escapeHtml(mermaidStore[Number(idx)] ?? '');
    return `<div class="md-mermaid-placeholder" data-mermaid="${code}"><div class="md-mermaid-fallback">Mermaid 图表（下方独立渲染）<pre>${code}</pre></div></div>`;
  });
  html = html.replace(/<!--vega:(\d+):vega-->/g, (_m: string, idx: string) => {
    const code = escapeHtml(vegaStore[Number(idx)] ?? '');
    return `<div class="md-vega-placeholder" data-vega="${code}"><div class="md-vega-fallback">数据图表（下方独立渲染）</div></div>`;
  });

  html = DOMPurify.sanitize(html, {
    ADD_TAGS: ['iframe', 'video', 'audio', 'source', 'span'],
    ADD_ATTR: [
      'allow',
      'allowfullscreen',
      'frameborder',
      'scrolling',
      'controls',
      'autoplay',
      'loop',
      'muted',
      'data-code',
      'data-lang',
      'data-block-id',
      'data-copy-id',
      'data-expand-id',
      'data-table',
      'data-mermaid',
      'data-vega',
      'loading',
      'referrerpolicy',
      'class',
    ],
  });

  // hljs 已在 renderer.code 阶段完成，此处仅做兜底
  html = postProcessHljs(html);
  return { html, mermaidStore, vegaStore };
};

const updateRenderedContent = async () => {
  if (!props.content) {
    renderedContent.value = '';
    mermaidCodes.value = [];
    vegaCodes.value = [];
    return;
  }
  try {
    const { html, mermaidStore, vegaStore } = await renderMarkdown(props.content);
    renderedContent.value = html;
    mermaidCodes.value = mermaidStore;
    vegaCodes.value = vegaStore;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : '未知错误';
    const stack = error instanceof Error ? error.stack || '' : '';
    renderedContent.value = `<div class="md-render-error"><div class="md-error-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg></div><div class="md-error-body"><h4>渲染错误</h4><p>${escapeHtml(msg)}</p><details><summary>详细信息</summary><pre>${escapeHtml(stack)}</pre></details></div></div>`;
  }
};

watch(
  () => [props.content, props.streaming, props.showLineNumbers, props.enableMath, props.enableMermaid],
  () => void updateRenderedContent(),
  { immediate: true },
);

const bindInteractivity = () => {
  if (!contentRef.value) return;

  contentRef.value.querySelectorAll<HTMLButtonElement>('.md-copy-btn').forEach((btn) => {
    btn.onclick = async (e) => {
      e.preventDefault();
      const id = btn.getAttribute('data-copy-id') || '';
      const pre = contentRef.value?.querySelector<HTMLPreElement>(`#${CSS.escape(id)}`);
      const code = pre?.getAttribute('data-code') || pre?.textContent || '';
      if (!code) return;
      try {
        await copyText(code);
        const copyIcon = btn.querySelector<HTMLElement>('.copy-icon');
        const checkIcon = btn.querySelector<HTMLElement>('.check-icon');
        const txt = btn.querySelector<HTMLElement>('.md-btn-text');
        if (copyIcon && checkIcon) {
          copyIcon.style.display = 'none';
          checkIcon.style.display = 'inline';
          if (txt) txt.textContent = '已复制';
          setTimeout(() => {
            copyIcon.style.display = 'inline';
            checkIcon.style.display = 'none';
            if (txt) txt.textContent = '复制';
          }, 1600);
        }
      } catch {
        // ignore
      }
    };
  });

  contentRef.value.querySelectorAll<HTMLButtonElement>('.md-expand-btn').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      const id = btn.getAttribute('data-expand-id') || '';
      const wrap = contentRef.value?.querySelector<HTMLElement>(`#wrap-${CSS.escape(id)}`);
      if (!wrap) return;
      wrap.classList.toggle('is-expanded');
      const expanded = wrap.classList.contains('is-expanded');
      btn.innerHTML = expanded
        ? '收起'
        : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 15 5 5 5-5"></path><path d="m7 9 5-5 5 5"></path></svg>';
      btn.title = expanded ? '收起' : '展开';
    };
  });

  contentRef.value.querySelectorAll<HTMLButtonElement>('.md-scroll-btn').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      const id = btn.getAttribute('data-table') || '';
      const container = contentRef.value?.querySelector<HTMLElement>(
        `#${CSS.escape(id)} .md-table-container`,
      );
      if (container) container.scrollBy({ left: 200, behavior: 'smooth' });
    };
  });
};

watch(renderedContent, () => nextTick(() => bindInteractivity()));
onMounted(() => nextTick(() => bindInteractivity()));

const hasMermaid = computed(() => mermaidCodes.value.length > 0);
const hasVega = computed(() => vegaCodes.value.length > 0);
</script>

<template>
  <div
    class="markdown-renderer"
    :class="[{ streaming, compact, 'math-enabled': enableMath }, `accent-${accent}`, `theme-${theme}`]"
    :style="maxHeight ? { maxHeight, overflowY: 'auto' } : undefined"
  >
    <template v-if="hasMermaid || hasVega">
      <div ref="contentRef" :class="['markdown-content', { streaming }]" v-html="renderedContent" />
      <template v-if="enableMermaid">
        <MermaidBlock v-for="(code, i) in mermaidCodes" :key="'m-' + i" :code="code" :closed="true" />
      </template>
      <template v-if="vegaCodes.length">
        <ChartBlock v-for="(code, i) in vegaCodes" :key="'v-' + i" :code="code" :closed="true" />
      </template>
    </template>

    <div
      v-else
      ref="contentRef"
      v-html="renderedContent"
      :class="['markdown-content', { streaming, 'math-enabled': enableMath }]"
    />

    <div v-if="streaming" class="md-stream-hint" aria-live="polite">正在生成…</div>
  </div>
</template>

<style scoped lang="scss">
.markdown-renderer {
  --md-primary: var(--color-brand);
  --md-primary-hover: var(--color-brand-hover);
  --md-primary-active: var(--scenario-selection-text);
  --md-primary-soft: var(--scenario-selection-bg);
  --md-primary-muted: var(--scenario-selection-bg);
  --md-primary-border: var(--scenario-selection-border);
  --md-primary-ring: rgb(var(--brand-rgb) / 0.28);
  --md-heading-h1: var(--scenario-selection-text);
  --md-heading-accent: var(--scenario-selection-text);
  --md-row-alt: var(--surface-subtle-bg);
  --md-on-primary: var(--color-text-inverse);
  --md-quote-strong: var(--scenario-selection-text);
  --md-fg: var(--color-text-primary);
  --md-fg-secondary: var(--color-text-secondary);
  --md-surface: var(--surface-card);
  --md-border: var(--border-light);
  width: 100%;
  color: var(--md-fg);
  font-size: 13.5px;
  line-height: 1.8;

  &.accent-yellow {
    --md-primary: #eab308;
    --md-primary-hover: #ca8a04;
    --md-primary-active: #a16207;
    --md-primary-soft: #fef9c3;
    --md-primary-muted: #fefce8;
    --md-primary-border: #fde68a;
    --md-primary-ring: rgba(234, 179, 8, 0.32);
    --md-heading-h1: #ca8a04;
    --md-heading-accent: #ca8a04;
    --md-row-alt: #fffdf5;
    --md-on-primary: #422006;
    --md-quote-strong: #854d0e;
  }

  &.accent-indigo {
    --md-primary: #6366f1;
    --md-primary-hover: #4f46e5;
    --md-primary-active: #4338ca;
    --md-primary-soft: #e0e7ff;
    --md-primary-muted: #eef2ff;
    --md-primary-border: #c7d2fe;
    --md-primary-ring: rgba(99, 102, 241, 0.32);
    --md-heading-h1: #4f46e5;
    --md-heading-accent: #4f46e5;
    --md-row-alt: #fafbff;
    --md-on-primary: #fff;
    --md-quote-strong: #4338ca;
  }

  &.compact {
    font-size: 12.5px;
    line-height: 1.7;
  }

  .markdown-content {
    line-height: 1.85;
    color: var(--md-fg);
    overflow-wrap: anywhere;

    &.streaming {
      position: relative;
      &::after {
        content: '▍';
        color: var(--md-primary);
        animation: md-blink 1s step-end infinite;
        margin-left: 3px;
        font-weight: 700;
      }
    }

    :deep(.md-heading) {
      margin: 1.4em 0 0.6em;
      font-weight: 700;
      line-height: 1.35;
      color: var(--md-fg);
      position: relative;
      letter-spacing: -0.2px;
      &:first-child {
        margin-top: 0;
      }
      .md-anchor {
        opacity: 0;
        margin-left: 8px;
        color: var(--md-primary);
        text-decoration: none;
        font-weight: 600;
        transition: opacity 0.15s;
      }
      &:hover .md-anchor {
        opacity: 1;
      }
    }
    :deep(.md-h1) {
      font-size: 1.7em;
      padding-bottom: 0.35em;
      color: var(--md-heading-h1, var(--md-heading-accent));
      border-bottom: 2px solid var(--md-primary-border);
    }
    :deep(.md-h2) {
      font-size: 1.4em;
      padding-bottom: 0.3em;
      color: var(--md-heading-accent);
      border-bottom: 1px solid var(--md-primary-border);
    }
    :deep(.md-h3) {
      font-size: 1.18em;
      color: var(--md-heading-accent);
    }
    :deep(.md-h4) {
      font-size: 1.02em;
      color: var(--md-fg);
    }
    :deep(h5),
    :deep(h6) {
      font-size: 0.95em;
      color: var(--color-text-secondary);
    }

    :deep(p) {
      margin: 0.85em 0;
      &:first-child {
        margin-top: 0;
      }
      &:last-child {
        margin-bottom: 0;
      }
    }

    :deep(ul),
    :deep(ol) {
      margin: 0.9em 0;
      padding-left: 1.6em;
      li {
        margin: 0.32em 0;
      }
    }
    :deep(ul) {
      list-style: disc;
      ul {
        list-style: circle;
        ul {
          list-style: square;
        }
      }
    }
    :deep(.md-list-item) {
      &::marker {
        color: var(--md-primary);
      }
    }
    :deep(.md-task-item) {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      list-style: none;
      margin-left: -1.2em;
      .md-task-checkbox {
        margin-top: 0.45em;
        accent-color: var(--md-primary);
      }
      &.checked .md-task-text {
        text-decoration: line-through;
        opacity: 0.6;
      }
    }

    :deep(code) {
      font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
      background: var(--md-primary-muted);
      border: 1px solid var(--md-primary-border);
      padding: 0.15em 0.4em;
      border-radius: 6px;
      font-size: 0.88em;
      color: var(--md-quote-strong);
    }
    :deep(pre) code {
      background: transparent;
      border: none;
      padding: 0;
      color: inherit;
      font-size: 1em;
    }

    :deep(.md-quote) {
      margin: 1.2em 0;
      padding: 12px 16px;
      border-radius: 12px;
      display: flex;
      gap: 10px;
      align-items: flex-start;
      border: 1px solid var(--border-light);
      box-shadow: var(--shadow-xs);
      background: var(--md-surface);
      .md-quote-icon {
        font-size: 1.15em;
        flex-shrink: 0;
        margin-top: 1px;
      }
      .md-quote-content {
        flex: 1;
        p {
          margin: 0.4em 0;
          &:first-child {
            margin-top: 0;
          }
          &:last-child {
            margin-bottom: 0;
          }
        }
      }
      &.md-quote-note {
        background: linear-gradient(135deg, var(--md-primary-muted), var(--md-primary-soft));
        border-left: 4px solid var(--md-primary);
      }
      &.md-quote-warning {
        background: var(--color-warning-bg);
        border-left: 4px solid var(--color-warning-text);
      }
      &.md-quote-tip {
        background: var(--color-success-bg);
        border-left: 4px solid var(--color-success-text);
      }
      &.md-quote-error {
        background: var(--color-danger-bg);
        border-left: 4px solid var(--color-danger-text);
      }
      &.md-quote-info {
        background: var(--color-info-bg);
        border-left: 4px solid var(--color-info-text);
      }
      &.md-quote-default {
        background: var(--md-primary-muted);
        border-left: 4px solid var(--md-primary);
      }
    }

    :deep(.md-code-block) {
      margin: 14px 0;
      border-radius: 14px;
      overflow: hidden;
      border: 1px solid var(--md-primary-border);
      box-shadow:
        0 4px 16px var(--md-primary-ring),
        0 1px 3px rgba(0, 0, 0, 0.06);
      background: var(--surface-card);
      transition:
        box-shadow 0.18s,
        border-color 0.18s,
        transform 0.18s;
      &:hover {
        box-shadow:
          0 8px 24px var(--md-primary-ring),
          0 2px 6px rgba(0, 0, 0, 0.08);
        border-color: var(--md-primary);
        transform: translateY(-1px);
      }

      .md-code-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 9px 12px 9px 14px;
        background: linear-gradient(135deg, var(--md-primary-muted), var(--md-primary-soft));
        border-bottom: 1px solid var(--md-primary-border);
        .md-code-info {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }
        .md-lang-tag {
          background: var(--md-primary);
          color: var(--md-on-primary);
          padding: 3px 9px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.4px;
          text-transform: uppercase;
          box-shadow: 0 1px 6px var(--md-primary-ring);
        }
        .md-code-stats {
          font-size: 11px;
          color: var(--color-text-tertiary);
          white-space: nowrap;
        }
        .md-code-actions {
          display: inline-flex;
          gap: 6px;
          align-items: center;
          flex-shrink: 0;
        }
        .md-action-btn {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          border: 1px solid var(--md-primary-border);
          background: var(--surface-card);
          color: var(--md-primary-active);
          border-radius: 8px;
          padding: 5px 10px;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s;
          &:hover {
            background: var(--md-primary);
            color: var(--md-on-primary);
            border-color: var(--md-primary);
            transform: translateY(-1px);
          }
          &:active {
            transform: translateY(0);
          }
        }
      }

      .md-code-content {
        display: flex;
        max-height: 520px;
        overflow: hidden;
        position: relative;
        background: #282c34; // atom-one-dark 底色，与 hljs 主题一致
        transition: max-height 0.28s ease;
        &.is-expanded {
          max-height: none;
        }
        .line-numbers {
          background: #21252b;
          color: #6b7280;
          padding: 16px 10px;
          font-family: 'SFMono-Regular', Menlo, monospace;
          font-size: 12px;
          line-height: 1.75;
          text-align: right;
          border-right: 1px solid #2c313c;
          user-select: none;
          white-space: pre;
          min-width: 44px;
        }
        .md-code-pre {
          flex: 1;
          margin: 0;
          padding: 16px 18px;
          overflow-x: auto;
          background: transparent;
          font-size: 12.8px;
          line-height: 1.75;
          color: #abb2bf;
          &::-webkit-scrollbar {
            height: 8px;
          }
          &::-webkit-scrollbar-thumb {
            background: #3e4451;
            border-radius: 4px;
          }
          code.hljs {
            background: transparent;
            padding: 0;
          }
        }
      }
    }

    :deep(.md-table-wrapper) {
      margin: 16px 0;
      border-radius: 14px;
      overflow: hidden;
      border: 1px solid var(--md-primary-border);
      box-shadow: var(--shadow-sm);
      background: var(--md-surface);
      .md-table-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: linear-gradient(135deg, var(--md-primary-muted), var(--md-primary-soft));
        border-bottom: 1px solid var(--md-primary-border);
        .md-table-info {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          font-weight: 700;
          font-size: 12px;
          color: var(--md-primary-active);
          .md-table-icon {
            color: var(--md-primary);
          }
        }
        .md-action-btn {
          border: 1px solid var(--md-primary-border);
          background: var(--md-surface);
          color: var(--md-primary-active);
          border-radius: 8px;
          padding: 4px 8px;
          font-size: 11px;
          cursor: pointer;
          &:hover {
            background: var(--md-primary);
            color: var(--md-on-primary);
          }
        }
      }
      .md-table-container {
        overflow-x: auto;
      }
      .md-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12.5px;
        background: var(--md-surface);
        th,
        td {
          padding: 10px 14px;
          border-bottom: 1px solid var(--md-border);
          text-align: left;
          white-space: nowrap;
        }
        th {
          background: var(--md-primary-muted);
          font-weight: 700;
          color: var(--md-quote-strong, var(--md-primary-active));
          position: sticky;
          top: 0;
        }
        tr:last-child td {
          border-bottom: none;
        }
        tbody tr:nth-child(even) {
          background: var(--md-row-alt);
        }
        tbody tr:hover {
          background: var(--md-primary-muted);
        }
      }
    }

    :deep(.md-link) {
      color: var(--md-primary-active);
      text-decoration: none;
      border-bottom: 1px dashed var(--md-primary-border);
      padding: 1px 2px;
      border-radius: 4px;
      transition: all 0.15s;
      &:hover {
        background: var(--md-primary-muted);
        border-bottom-color: var(--md-primary);
        color: var(--md-primary-active);
      }
      .md-link-icon {
        margin-left: 4px;
        opacity: 0.8;
        font-size: 0.9em;
      }
      &.is-external {
        color: var(--md-primary-active);
      }
      &.is-email {
        color: var(--color-success-text);
        border-bottom-color: var(--color-success-border);
      }
      &.is-file {
        color: var(--color-danger-text);
      }
    }

    :deep(hr) {
      border: none;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--md-primary-border), transparent);
      margin: 20px 0;
    }
    :deep(strong) {
      font-weight: 700;
      color: var(--color-text-primary);
    }
    :deep(em) {
      font-style: italic;
      color: var(--color-text-secondary);
    }
    :deep(del) {
      text-decoration: line-through;
      opacity: 0.65;
    }
    :deep(mark) {
      background: var(--md-primary-soft);
      padding: 2px 4px;
      border-radius: 4px;
    }

    :deep(img) {
      max-width: 100%;
      height: auto;
      border-radius: 12px;
      box-shadow: var(--shadow-sm);
      margin: 10px 0;
      border: 1px solid var(--border-light);
    }
    :deep(a.markdown-image-link) {
      display: inline-block;
      max-width: 100%;
      text-decoration: none;
      border: none;
    }

    :deep(.md-mermaid-placeholder),
    :deep(.md-vega-placeholder) {
      margin: 12px 0;
      padding: 12px;
      background: var(--surface-subtle-bg);
      border: 1px dashed var(--md-primary-border);
      border-radius: 10px;
      color: var(--color-text-tertiary);
      font-size: 12px;
      pre {
        background: var(--surface-card);
        border: 1px solid var(--border-light);
        padding: 10px;
        border-radius: 8px;
        margin-top: 8px;
        color: var(--color-text-secondary);
      }
    }

    :deep(.math-inline) {
      font-family: 'KaTeX_Main', 'Times New Roman', serif;
      background: var(--md-primary-muted);
      border: 1px solid var(--md-primary-border);
      color: var(--md-quote-strong);
      padding: 1px 6px;
      border-radius: 6px;
      font-size: 1.06em;
    }
    :deep(.math-block) {
      text-align: center;
      margin: 16px 0;
      padding: 14px;
      background: var(--md-primary-muted);
      border: 1px solid var(--md-primary-border);
      border-radius: 12px;
      overflow-x: auto;
      font-family: 'KaTeX_Main', serif;
      font-size: 1.15em;
      color: var(--md-quote-strong);
    }

    :deep(.md-render-error) {
      display: flex;
      gap: 12px;
      padding: 16px;
      background: var(--color-danger-bg);
      border: 1px solid var(--color-danger-border);
      border-radius: 12px;
      color: var(--color-danger-text);
      .md-error-icon {
        font-size: 20px;
      }
      h4 {
        margin: 0 0 6px;
        color: var(--color-danger-text);
      }
      details summary {
        cursor: pointer;
        color: var(--color-danger-text);
        font-weight: 600;
      }
      pre {
        background: var(--surface-subtle-bg);
        padding: 8px;
        border-radius: 8px;
        font-size: 11px;
        margin-top: 8px;
      }
    }

    // highlight.js 在暗底上的微调（覆盖 atom-one-dark 的 pre 背景，保持与外壳一致）
    :deep(.hljs) {
      background: transparent !important;
      color: #abb2bf;
    }
    :deep(.hljs-pre) {
      background: transparent;
    }
  }

  .md-stream-hint {
    margin-top: 10px;
    font-size: 11px;
    color: var(--md-primary-active);
    background: var(--md-primary-muted);
    border: 1px solid var(--md-primary-border);
    padding: 6px 10px;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    &::before {
      content: '';
      width: 7px;
      height: 7px;
      background: var(--md-primary);
      border-radius: 50%;
      animation: md-pulse 1.2s infinite;
    }
  }
}

@keyframes md-blink {
  0%,
  50% {
    opacity: 1;
  }
  51%,
  100% {
    opacity: 0;
  }
}
@keyframes md-pulse {
  0% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(1.25);
    opacity: 0.6;
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}

// auto 跟随站点暗色模式；显式 light/dark 可在任意页面单独使用。
@mixin dark-preview {
  color-scheme: dark;
  --md-fg: #e5e7eb;
  --md-fg-secondary: #aeb4c1;
  --md-surface: #222630;
  --md-border: #3b4250;
  --md-primary: var(--brand-400);
  --md-primary-active: var(--brand-400);
  --md-heading-h1: var(--brand-300);
  --md-heading-accent: var(--brand-400);
  --md-primary-soft: rgb(var(--brand-rgb) / 0.18);
  --md-primary-muted: rgb(var(--brand-rgb) / 0.1);
  --md-primary-border: rgb(var(--brand-rgb) / 0.35);
  --md-row-alt: #272a31;
  --md-quote-strong: var(--brand-200);

  &.accent-yellow {
    --md-primary: #facc15;
    --md-primary-active: #facc15;
    --md-heading-h1: #facc15;
    --md-heading-accent: #facc15;
    --md-primary-soft: #473b16;
    --md-primary-muted: #302a18;
    --md-primary-border: #75621c;
    --md-row-alt: #272a31;
    --md-quote-strong: #fde68a;
  }

  &.accent-indigo {
    --md-primary: #a5b4fc;
    --md-primary-active: #a5b4fc;
    --md-heading-h1: #a5b4fc;
    --md-heading-accent: #a5b4fc;
    --md-primary-soft: #303663;
    --md-primary-muted: #252a48;
    --md-primary-border: #565e9d;
    --md-row-alt: #292c3a;
    --md-quote-strong: #c7d2fe;
  }

  .markdown-content :deep(.md-quote) {
    background: var(--md-surface);
  }
}

.markdown-renderer.theme-light {
  color-scheme: light;
  --md-fg: #1f2937;
  --md-fg-secondary: #64748b;
  --md-surface: #fff;
  --md-border: #e5e7eb;
}

.markdown-renderer.theme-dark {
  @include dark-preview;
}

:global(:root[data-theme='dark']) .markdown-renderer.theme-auto {
  @include dark-preview;
}

@media (prefers-color-scheme: dark) {
  :global(:root:not([data-theme='light'])) .markdown-renderer.theme-auto {
    @include dark-preview;
  }
}

@media (max-width: 768px) {
  .markdown-renderer {
    font-size: 12.5px;
    .markdown-content :deep(.md-code-block) {
      .md-code-header {
        padding: 8px 10px;
        .md-lang-tag {
          font-size: 10px;
        }
        .md-code-stats {
          display: none;
        }
      }
      .md-code-content .md-code-pre {
        padding: 12px;
        font-size: 12px;
      }
    }
    .markdown-content :deep(.md-table-wrapper) {
      font-size: 12px;
      .md-table th,
      .md-table td {
        padding: 8px 10px;
      }
    }
  }
}
</style>
