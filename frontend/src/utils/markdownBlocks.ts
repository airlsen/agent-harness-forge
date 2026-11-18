/**
 * 把 Markdown 文本切成有序渲染块：连续的普通内容合并为 html 块，
 * 围栏代码块单独成块（代码 / mermaid 图 / vega 图表由对应组件接管）。
 * 流式场景下文本只会从尾部增长，历史块的 key 与内容保持稳定，
 * 因此只有最后一个块会被重复解析与高亮。
 */
import { marked, type Token, type Tokens } from 'marked';
import DOMPurify from 'dompurify';

export type MarkdownBlock =
  | { kind: 'html'; html: string; key: string }
  | { kind: 'code'; lang: string; code: string; closed: boolean; key: string };

const SANITIZE_OPTIONS = {
  FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button', 'img'],
  FORBID_ATTR: ['style'],
};

/** 围栏代码块是否已闭合（流式中未闭合的块先按纯文本渲染，不做高亮/渲染图） */
export function fenceClosed(raw: string): boolean {
  const opening = raw.match(/^(`{3,}|~{3,})/);
  if (!opening) return true; // 缩进代码块没有围栏，天然视为闭合
  const fence = opening[1];
  const body = raw.slice(raw.indexOf('\n') + 1);
  const closer = new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`, 'm');
  return closer.test(body);
}

export function splitMarkdown(text: string): MarkdownBlock[] {
  const tokens = marked.lexer(text ?? '', { breaks: true });
  const blocks: MarkdownBlock[] = [];
  let htmlGroup: Token[] = [];
  const flushHtml = () => {
    if (!htmlGroup.length) return;
    const html = DOMPurify.sanitize(marked.parser(htmlGroup, { breaks: true }), SANITIZE_OPTIONS);
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
