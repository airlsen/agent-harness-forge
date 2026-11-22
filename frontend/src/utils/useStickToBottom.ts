import { onBeforeUnmount, ref, watch, type Ref } from 'vue';

/**
 * 消息流「跟随最新」：工作台会话与 Skill 编写助手共用。
 * - 只有用户自己往上翻（滚动位置变小且离开底部）才停止跟随；内容变高、变矮或程序滚动都不会误判；
 * - 跟随中内容高度因任何原因变化（流式文字、过程块、代码高亮、图片等）都保持贴底，
 *   不依赖调用方枚举哪些数据变化会撑高页面。
 * 底部 threshold 像素以内视为「在底部」，回到这里自动恢复跟随。
 */
export function useStickToBottom(pane: Ref<HTMLElement | null | undefined>, threshold = 120) {
  const stick = ref(true);
  let lastTop = 0;

  function atBottom(el: HTMLElement) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
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
    if (atBottom(el)) stick.value = true;
    // 内容变高不会让滚动位置变小；变矮时浏览器把位置夹到底部，也会落在上一个分支
    else if (el.scrollTop < lastTop - 1) stick.value = false;
    lastTop = el.scrollTop;
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

  // 观察滚动容器及其直接子元素的尺寸；子元素增删（新消息、加载状态切换）时重新挂载观察
  let resize: ResizeObserver | null = null;
  let children: MutationObserver | null = null;
  function detach() {
    resize?.disconnect();
    children?.disconnect();
    resize = children = null;
  }
  watch(
    pane,
    (el) => {
      detach();
      if (!el || typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() => follow());
      const observeAll = () => {
        observer.disconnect();
        observer.observe(el);
        for (const child of Array.from(el.children)) observer.observe(child);
      };
      observeAll();
      resize = observer;
      if (typeof MutationObserver !== 'undefined') {
        children = new MutationObserver(() => {
          observeAll();
          follow();
        });
        children.observe(el, { childList: true });
      }
    },
    { immediate: true, flush: 'post' },
  );
  onBeforeUnmount(detach);

  return { stick, onScroll, follow, jumpToLatest, scrollToBottom };
}
