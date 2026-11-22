# 内容渲染组件（markdown）

把 Markdown、代码、流程图、图表、JSON 渲染成好看的内容，遵循系统品牌色系。

- `MarkdownContent.vue` — 会话消息、执行过程、已发布技能详情里的 Markdown 渲染
- `MarkdownPreview.vue` — 文件预览、Skill 编辑器预览里的 Markdown 文档渲染（见下）
- `CodeBlock.vue` / `MermaidBlock.vue` / `ChartBlock.vue` — 代码块、流程图、Vega 图表
- `JsonPreview.vue` — JSON 预览（见下，暂未接入页面）

## 组件

- `MarkdownPreview.vue` — Markdown 漂亮渲染（系统品牌色主题）
  - 能力：GFM、代码高亮（复用 `utils/highlight` Shiki）、表格、引用（note/warning/tip/error/info）、任务列表、链接/图片、数学公式占位、Mermaid / Vega 委托给 `MermaidBlock` / `ChartBlock`、流式光标、行号、复制/展开
  - 主题：默认使用系统品牌色系（`var(--brand-600)` ~ `var(--brand-800)`），支持 `accent="brand" | "yellow" | "indigo"`
  - Props：`content`、`streaming`、`enableMath`、`enableMermaid`、`showLineNumbers`、`maxHeight`、`compact`、`accent`、`theme`
- `JsonPreview.vue` — JSON 美化预览
  - 能力：树状折叠、类型徽标、搜索高亮、复制节点/整体、全展/收起、体积统计
  - Props：`data`、`rootName`、`expanded`、`showType`、`maxHeight`、`searchable`

## 使用

```vue
<script setup lang="ts">
import MarkdownPreview from '../../components/markdown/MarkdownPreview.vue';
import JsonPreview from '../../components/markdown/JsonPreview.vue';
</script>

<template>
  <MarkdownPreview :content="md" streaming show-line-numbers enable-mermaid />
  <JsonPreview :data="jsonData" root-name="result" expanded show-type searchable />
</template>
```

`FilePreview.vue` 中 markdown 预览已示例接入 `MarkdownPreview`。
