/**
 * 把 Markdown 文本切成有序渲染块：连续的普通内容合并为 html 块，
 * 图片语法与明显的裸图片地址安全地内嵌；围栏代码块单独成块（代码 / mermaid / vega 由对应组件接管）。
 * 流式场景下文本只会从尾部增长，历史块的 key 与内容保持稳定，
 * 因此只有最后一个块会被重复解析与高亮。
 */
import { marked, Renderer, type Token, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import { looksLikeImageUrl, normalizeHttpUrl, normalizeRemoteImageUrl } from './remoteImages';

export type MarkdownBlock =
  | { kind: 'html'; html: string; key: string }
  | { kind: 'code'; lang: string; code: string; closed: boolean; key: string };

const SANITIZE_OPTIONS = {
  FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button'],
  // `srcset` can silently request a different resource than the validated `src`.
  FORBID_ATTR: ['style', 'srcset'],
};

const URL_PATTERN = /https?:\/\/[^\s<>\"'`]+/gi;
const TRAILING_URL_PUNCTUATION = /[.,!?;:，。！？、]$/u;
const BRACKET_PAIRS: Array<[string, string]> = [
  [')', '('],
  [']', '['],
  ['}', '{'],
];
const IMAGE_FAILURE_ALT = '图片加载失败；点击打开原图';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function trimUrlPunctuation(value: string): [string, string] {
  let end = value.length;
  while (end > 0 && TRAILING_URL_PUNCTUATION.test(value[end - 1])) end -= 1;

  // Keep balanced parentheses/brackets in URLs, but leave sentence-closing punctuation outside.
  for (const [closing, opening] of BRACKET_PAIRS) {
    while (end > 0 && value[end - 1] === closing) {
      const prefix = value.slice(0, end);
      const openingCount = prefix.split(opening).length - 1;
      const closingCount = prefix.split(closing).length - 1;
      if (closingCount <= openingCount) break;
      end -= 1;
    }
  }

  return [value.slice(0, end), value.slice(end)];
}

function renderImageLink(url: string): string {
  const safeUrl = escapeHtml(url);
  return `<a class="markdown-image-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer"><img src="${safeUrl}" alt="${IMAGE_FAILURE_ALT}"></a>`;
}

function linkifyText(text: string, allowRemoteImages: boolean): string {
  let result = '';
  let cursor = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const rawUrl = match[0];
    const start = match.index ?? 0;
    const [candidate, punctuation] = trimUrlPunctuation(rawUrl);
    const href = normalizeHttpUrl(candidate);

    result += escapeHtml(text.slice(cursor, start));
    if (!href) {
      result += escapeHtml(rawUrl);
    } else if (allowRemoteImages && looksLikeImageUrl(href)) {
      result += renderImageLink(href);
      result += escapeHtml(punctuation);
    } else {
      result += `<a class="markdown-external-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(candidate)}</a>`;
      result += escapeHtml(punctuation);
    }
    cursor = start + rawUrl.length;
  }

  return result + escapeHtml(text.slice(cursor));
}

function createMarkdownRenderer(allowRemoteImages: boolean): Renderer {
  const renderer = new Renderer();
  const renderText = renderer.text.bind(renderer);
  const renderLink = renderer.link.bind(renderer);
  let renderingLinkLabel = false;

  renderer.text = (token) => {
    // Keep normal Markdown parsing for nested formatting, entities, and text inside explicit links.
    if (token.type !== 'text' || token.escaped || token.tokens || renderingLinkLabel)
      return renderText(token);
    return linkifyText(token.text, allowRemoteImages);
  };

  renderer.link = (token: Tokens.Link) => {
    const imageUrl = normalizeRemoteImageUrl(token.href);
    if (
      allowRemoteImages &&
      imageUrl &&
      token.text.trim() === token.href.trim() &&
      looksLikeImageUrl(imageUrl)
    ) {
      return renderImageLink(imageUrl);
    }

    renderingLinkLabel = true;
    try {
      return renderLink(token);
    } finally {
      renderingLinkLabel = false;
    }
  };

  return renderer;
}

function sanitizeMarkdownHtml(html: string, allowRemoteImages: boolean): string {
  const fragment = DOMPurify.sanitize(html, {
    ...SANITIZE_OPTIONS,
    RETURN_DOM_FRAGMENT: true,
  }) as DocumentFragment;
  const document = fragment.ownerDocument;
  const container = document.createElement('div');
  container.append(fragment);

  for (const image of Array.from(container.querySelectorAll('img'))) {
    const alt = image.getAttribute('alt') ?? '';
    if (!allowRemoteImages) {
      if (alt) image.replaceWith(document.createTextNode(alt));
      else image.remove();
      continue;
    }

    const imageUrl = normalizeRemoteImageUrl(image.getAttribute('src') ?? '');
    if (!imageUrl) {
      if (alt) image.replaceWith(document.createTextNode(alt));
      else image.remove();
      continue;
    }

    image.setAttribute('src', imageUrl);
    image.setAttribute('loading', 'lazy');
    image.setAttribute('decoding', 'async');
    image.setAttribute('referrerpolicy', 'no-referrer');

    if (!image.closest('a')) {
      const link = document.createElement('a');
      link.className = 'markdown-image-link';
      link.href = imageUrl;
      image.replaceWith(link);
      link.append(image);
    }
  }

  // DOMPurify removes target by default; only re-add it to links we created ourselves.
  for (const link of Array.from(
    container.querySelectorAll('a.markdown-image-link, a.markdown-external-link'),
  )) {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }

  return container.innerHTML;
}

/** 围栏代码块是否已闭合（流式中未闭合的块先按纯文本渲染，不做高亮/渲染图） */
export function fenceClosed(raw: string): boolean {
  const opening = raw.match(/^(`{3,}|~{3,})/);
  if (!opening) return true; // 缩进代码块没有围栏，天然视为闭合
  const fence = opening[1];
  const body = raw.slice(raw.indexOf('\n') + 1);
  const closer = new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`, 'm');
  return closer.test(body);
}

export function splitMarkdown(text: string, options: { live?: boolean } = {}): MarkdownBlock[] {
  const allowRemoteImages = !options.live;
  const tokens = marked.lexer(text ?? '', { breaks: true });
  const blocks: MarkdownBlock[] = [];
  let htmlGroup: Token[] = [];
  const flushHtml = () => {
    if (!htmlGroup.length) return;
    const rendered = marked.parser(htmlGroup, {
      breaks: true,
      renderer: createMarkdownRenderer(allowRemoteImages),
    });
    const html = sanitizeMarkdownHtml(rendered, allowRemoteImages);
    htmlGroup = [];
    if (!html.trim()) return;
    blocks.push({ kind: 'html', html, key: `h${blocks.length}` });
  };
  for (const token of tokens) {
    if (token.type === 'code') {
      flushHtml();
      const code = (token as Tokens.Code).text;
      blocks.push({
        kind: 'code',
        lang: ((token as Tokens.Code).lang ?? '').trim().toLowerCase(),
        code,
        closed: fenceClosed(token.raw),
        key: `c${blocks.length}`,
      });
    } else {
      htmlGroup.push(token);
    }
  }
  flushHtml();
  return blocks;
}
