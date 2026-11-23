/**
 * antd Drawer 的根节点没有 dialog 语义（role / aria-modal），读屏与回归脚本都找不到它。
 * 打开时补上；关闭后根节点仍留在 DOM 中且铺满视口，不能继续暴露为对话框。
 * 用法：<a-drawer v-bind="drawerA11y('工具详情', open)">（aria-label 等透传属性落在 .ant-drawer 根节点）
 */
export function drawerA11y(label: string, open: boolean): Record<string, string> {
  return open ? { role: 'dialog', 'aria-modal': 'true', 'aria-label': label } : {};
}
