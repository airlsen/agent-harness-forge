# 公共展示组件

与 `JsonPreview` 同级，置于 `components/common` 下，保持「黄色主题」。

## 组件

- `MarkdownPreview.vue` — Markdown 漂亮渲染（黄色主题）
  - 能力：GFM、代码高亮（复用 `utils/highlight` Shiki）、表格、引用（note/warning/tip/error/info）、任务列表、链接/图片、数学公式占位、Mermaid / Vega 委托给 `MermaidBlock` / `ChartBlock`、流式光标、行号、复制/展开
  - 主题：`--md-primary #eab308` 局部变量，不污染全局 `brand`
  - Props：`content`、`streaming`、`enableMath`、`enableMermaid`、`showLineNumbers`、`maxHeight`、`compact`
- `JsonPreview.vue` — JSON 美化预览（黄色主题）
  - 能力：树状折叠、类型徽标、搜索高亮、复制节点/整体、全展/收起、体积统计
  - Props：`data`、`rootName`、`expanded`、`showType`、`maxHeight`、`searchable`

## 使用

```vue
<script setup lang="ts">
import { MarkdownPreview, JsonPreview } from '@/components/common'
</script>

<template>
  <MarkdownPreview :content="md" streaming show-line-numbers enable-mermaid />
  <JsonPreview :data="jsonData" root-name="result" expanded show-type searchable />
</template>
```

`FilePreview.vue` 中 markdown 预览已示例接入 `MarkdownPreview`。
