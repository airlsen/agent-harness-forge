# 公共源码编辑器

`MonacoEditor.vue` 默认 Markdown、vs-dark、自动换行、关闭缩略图；首次挂载时加载本地 Monaco 与 Worker。

```vue
<MonacoEditor
  v-model="content"
  :model-key="filePath"
  language="markdown"
  :active="mode === 'source'"
  :loading="fileLoading"
  :read-only="readOnly"
  @shortcut-save="save"
/>
```

- 父容器必须提供可计算高度，通常使用 `flex: 1; min-height: 0`。切换预览用 `v-show` 保留实例；首次打开源码后再挂载可以延迟加载。
- `modelKey` 在组件内部唯一标识文件。组件为访问过的文件保留 model、撤销历史与视图状态，卸载时统一释放；不同组件实例互相隔离。
- 异步切换文件时先设置 `loading`，同时更新文件 key；内容到达后再解除 loading，避免空占位内容覆盖旧文件。加载失败时继续保持 loading。
- 外部 `modelValue` 更新作为一个独立的可撤销编辑，不发出 change / update:modelValue。用户输入、撤销、重做正常发出这两个事件。
- 支持 `ready`、`shortcut-save`、`content-selected`、`selection-cleared` 事件；暴露 `getEditor()`、`getValue()`、`focus()`、`layout()`。
- 可配置 `language`、`theme`、`height`、`ariaLabel`、`options`。当前按需注册 Markdown、YAML；其他语言需要在 `utils/editor/monaco.ts` 添加注册，配置 language 本身不会自动安装语言服务。
- Monaco 的主题是页面级设置；同一页面的多个实例应使用相同主题。未提供 Markdown 格式化服务，也不承诺移动浏览器编辑兼容性。

技能预览使用 `MarkdownContent` 的 `variant="document"`，默认 `message` 保持聊天原有排版。

回归：`node frontend/scripts/check-monaco-editor.mjs` 使用 jsdom 与真实 Vue / Monaco 检查编辑历史、文件切换、外部更新、多实例隔离和释放；不代替浏览器像素布局与 Worker 验收。
