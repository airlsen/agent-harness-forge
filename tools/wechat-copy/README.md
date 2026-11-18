# wechat-copy — HTML 原样粘贴进微信公众号

解决「自己排好的 HTML 复制进公众号后台就丢样式」的问题。

## 原理

微信公众号编辑器会清洗掉 `<style>` 标签、`class`、外部 CSS 文件，**只保留写在元素上的内联 `style`**。
本工具用 [juice](https://github.com/Automattic/juice) 把你的全部 CSS 内联到每个元素上，
再清洗掉公众号不支持的标签和属性，最后生成一个带「一键复制」按钮的预览页。

## 安装

```bash
cd tools/wechat-copy
npm install
```

## 使用

```bash
node inline-wechat.js 你的文章.html            # 生成 你的文章.wechat.html
node inline-wechat.js 你的文章.html -o out.html # 指定输出路径
```

然后：

1. 用 **Chrome / Edge** 打开生成的 `.wechat.html`
2. 点击顶部绿色按钮「**复制正文**」
3. 到公众号后台编辑器 `Ctrl+V` 粘贴

## 它会做什么

- ✅ `<style>`、外链 CSS、class 样式 → 全部转成内联 `style`
- ✅ 删除公众号会过滤的标签：`script / iframe / form / input / video` 等
- ✅ 删除事件属性（`onclick` 等）、`class`、`id`（公众号反正会剥掉）
- ✅ 剔除公众号不支持的 CSS：`position / float / transform / var()` 等
- ✅ 预览页按手机宽度（677px）展示，所见即所得

## 注意事项

- **图片**：公众号对外链图片有防盗链限制，粘贴后如果图片裂了，需要在后台重新上传，或先把图片传到公众号素材/图床。
- **CSS 动画、悬浮效果、fixed 定位**：公众号一律不支持，会被本工具移除。
- **复杂布局**：多列浮动布局粘贴后可能错位，建议 HTML 里用 `table` 或单列布局（这也是公众号排版工具普遍的做法）。
- 外链超链接在公众号正文里不可点击，是平台限制，与工具无关。
