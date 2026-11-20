# 公共展示组件

置于 `components/common` 下，遵循系统品牌色系。

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
import { MarkdownPreview, JsonPreview } from '@/components/common';
</script>

<template>
  <MarkdownPreview :content="md" streaming show-line-numbers enable-mermaid />
  <JsonPreview :data="jsonData" root-name="result" expanded show-type searchable />
</template>
```

`FilePreview.vue` 中 markdown 预览已示例接入 `MarkdownPreview`。
