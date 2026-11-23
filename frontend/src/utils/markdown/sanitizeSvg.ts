import DOMPurify from 'dompurify';

/**
 * 消毒 Mermaid 输出的 SVG。
 * 流程图/类图等的节点文字是 <foreignObject> 里的 HTML（div/span/p），
 * 只开 svg profile 会把 foreignObject 整个删掉，导致节点框里没有文字；
 * 因此同时开 html profile 并把 foreignObject 声明为 HTML 集成点。
 * 脚本、事件属性、javascript: 链接等仍按 DOMPurify 默认规则移除。
 */
export function sanitizeDiagramSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ['foreignObject'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_TAGS: ['iframe', 'form', 'input', 'button', 'textarea', 'select', 'img', 'video', 'audio'],
  });
}
