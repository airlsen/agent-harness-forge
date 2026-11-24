import { ref } from 'vue';
import { notify } from '../utils/common/feedback';

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
      return true;
    } catch {
      copied.value = false;
      notify('error', '复制失败，请检查浏览器剪贴板权限后重试');
      return false;
    }
  }
  return { copied, copy };
}
