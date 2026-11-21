# Forge 平台知识

写 Skill 时只能使用下列能力。某项能力取决于场景配置时，在 Skill 里写成条件，例如"如果可以搜索网络……，否则请用户提供资料"。

## Skill 怎么被使用

- 业务会话列出已启用 Skill 的名称和 description，模型判断任务相符时加载正文，再照着执行
- 用户在消息开头输入 /名称，可以直接指定 Skill
- 参考资料不会自动读入，正文里写明"什么时候读哪份"，模型才会去读

## 业务会话里的工具

| 能力 | 工具 | 是否一定可用 |
|---|---|---|
| 当前时间 | current_time | 一般可用 |
| 会话工作区文件 | workspace_list / workspace_read / workspace_write | 一般可用 |
| 交付文件卡片 | workspace_present | 能写文件时可用 |
| 搜索文件 | glob / grep | 能读文件或关联了代码时可用 |
| 只读读取代码和参考资料 | read | 关联了代码或 Skill 有参考资料时可用 |
| 终端命令 | bash | 看企业策略，修改类命令需要用户确认 |
| 联网 | web_search / web_fetch | 看场景配置 |
| 外部系统 | MCP 工具 | 看场景配置，名称以实际为准 |

生成报告、代码等交付物时，写成"用 workspace_write 保存为 xxx.md，再用 workspace_present 交付"。

## 界面渲染能力

- Markdown 表格、代码块会直接渲染
- mermaid 代码块渲染为流程图、时序图、架构图
- vega 代码块（Vega-Lite JSON，数据写在 data.values 里）渲染为柱状图、折线图、饼图

## 限制

- name：英文字母或数字开头，只能包含字母、数字、点、下划线、短横线，最长 64 个字符
- title：最长 120 字
- description：1–512 字
- 正文：不超过 64KB
- 参考资料：最多 10 份，每份不超过 120KB，只读
