import { onBeforeUnmount, ref, watch, type Ref } from 'vue';

/**
 * 消息流「跟随最新」：工作台会话与 Skill 编写助手共用。
 * - 用户一有往上翻的动作（滚轮上滚、手指下拉、上翻按键、拖动滚动条往上）就立即停止跟随，
 *   不必先翻出一段距离；否则流式输出每帧撑高内容都会把人拽回底部，永远翻不上去；
 * - 内容变高、变矮或程序滚动都不会误判；
 * - 跟随中内容高度因任何原因变化（流式文字、过程块、代码高亮、图片等）都保持贴底，
 *   不依赖调用方枚举哪些数据变化会撑高页面。
 * 用户往下翻到离底部 threshold 像素以内时自动恢复跟随。
 */
export function useStickToBottom(pane: Ref<HTMLElement | null | undefined>, threshold = 120) {
  const stick = ref(true);
  let lastTop = 0;

  function distanceToBottom(el: HTMLElement) {
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }
  function scrollToBottom() {
    const el = pane.value;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop = el.scrollTop;
  }
  /** 绑定到滚动容器的 scroll 事件 */
  function onScroll() {
    const el = pane.value;
    if (!el) return;
    const top = el.scrollTop;
    const distance = distanceToBottom(el);
    // 位置变小且不在底部：用户往上翻。内容变矮时浏览器把位置夹到底部，距离为 0，不算上翻
    if (top < lastTop - 1 && distance > 2) stick.value = false;
    // 往下翻回底部附近（或本来就在底部）：恢复跟随
    else if (distance <= 2 || (top > lastTop && distance < threshold)) stick.value = true;
    lastTop = top;
  }
  /** 跟随中则滚到底部 */
  function follow() {
    if (stick.value) scrollToBottom();
  }
  /** 「回到最新」或用户发送新消息：恢复跟随并滚到底部 */
  function jumpToLatest() {
    stick.value = true;
    scrollToBottom();
  }

  /** 从事件目标到滚动容器之间是否有内层区域还能往上滚（比如代码块、过程详情）：那时滚动的是内层 */
  function innerCanScrollUp(target: EventTarget | null, el: HTMLElement) {
    for (
      let node = target instanceof Element ? target : null;
      node && node !== el;
      node = node.parentElement
    ) {
      if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight) {
        const overflow = window.getComputedStyle(node).overflowY;
        if (overflow === 'auto' || overflow === 'scroll') return true;
      }
    }
    return false;
  }
  /** 用户明确要往上看：立即停止跟随 */
  function release(el: HTMLElement, target: EventTarget | null) {
    if (el.scrollTop > 0 && !innerCanScrollUp(target, el)) stick.value = false;
  }

  // 观察滚动容器及其直接子元素的尺寸；子元素增删（新消息、加载状态切换）时重新挂载观察
  let cleanup: (() => void) | null = null;
  function detach() {
    cleanup?.();
    cleanup = null;
  }
  watch(
    pane,
    (el) => {
      detach();
      if (!el) return;
      const disposers: Array<() => void> = [];
      const listen = <K extends keyof HTMLElementEventMap>(
        type: K,
        handler: (event: HTMLElementEventMap[K]) => void,
      ) => {
        el.addEventListener(type, handler, { passive: true });
        disposers.push(() => el.removeEventListener(type, handler));
      };
      listen('wheel', (event) => {
        if (event.deltaY < 0) release(el, event.target);
      });
      let touchY: number | null = null;
      listen('touchstart', (event) => (touchY = event.touches[0]?.clientY ?? null));
      listen('touchmove', (event) => {
        const y = event.touches[0]?.clientY;
        // 手指往下拉 = 内容往上翻
        if (touchY !== null && y !== undefined && y > touchY + 4) release(el, event.target);
      });
      listen('keydown', (event) => {
        if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) release(el, event.target);
      });

      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => follow());
        const observeAll = () => {
          observer.disconnect();
          observer.observe(el);
          for (const child of Array.from(el.children)) observer.observe(child);
        };
        observeAll();
        disposers.push(() => observer.disconnect());
        if (typeof MutationObserver !== 'undefined') {
          const children = new MutationObserver(() => {
            observeAll();
            follow();
          });
          children.observe(el, { childList: true });
          disposers.push(() => children.disconnect());
        }
      }
      cleanup = () => disposers.forEach((dispose) => dispose());
    },
    { immediate: true, flush: 'post' },
  );
  onBeforeUnmount(detach);

  return { stick, onScroll, follow, jumpToLatest, scrollToBottom };
}
