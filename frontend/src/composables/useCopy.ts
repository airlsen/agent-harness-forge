import { ref } from 'vue';

/** 复制到剪贴板并给出 1.5s 的「已复制」反馈 */
export function useCopy() {
  const copied = ref(false);
  let timer: number | undefined;
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied.value = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => (copied.value = false), 1500);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  }
  return { copied, copy };
}
