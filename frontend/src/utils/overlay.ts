import { shallowRef, watch, type ShallowRef } from 'vue';

/**
 * antd Drawer 的根节点没有 dialog 语义（role / aria-modal），读屏与回归脚本都找不到它。
 * 打开时补上；关闭后根节点仍留在 DOM 中且铺满视口，不能继续暴露为对话框。
 * 用法：<a-drawer v-bind="drawerA11y('工具详情', open)">（aria-label 等透传属性落在 .ant-drawer 根节点）
 */
export function drawerA11y(label: string, open: boolean): Record<string, string> {
  return open ? { role: 'dialog', 'aria-modal': 'true', 'aria-label': label } : {};
}

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
