import { shallowRef, watch, type ShallowRef } from 'vue';

/**
 * 保留最近一次非空的值：抽屉 / 对话框关闭动画期间，数据源已被置空，
 * 内容仍用上一次的值渲染，避免面板滑出时内容先消失。
 */
export function useRetained<T>(source: () => T | null | undefined): ShallowRef<T | null> {
  const last = shallowRef<T | null>(source() ?? null);
  watch(source, (value) => {
    if (value) last.value = value;
  });
  return last;
}
