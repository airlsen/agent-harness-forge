# Forge 平台知识

写 Skill 时只能使用下列能力。某项能力取决于场景配置时，在 Skill 里写成条件，例如"如果可以搜索网络……，否则请用户提供资料"。

## Skill 怎么被使用

- 业务会话列出已启用 Skill 的名称和 description，模型判断任务相符时加载正文，再照着执行
- Skill 工作台会话也会加载当前未发布草稿；维护者直接给出任务时，先通过 skill 工具加载本轮草稿快照并执行。修改后的新修订在下一条消息生效
- 用户在消息开头输入 /名称，可以直接指定 Skill
- references/、assets/ 中的文件不会自动读入：正文里用相对路径写明什么时候读或用，模型才会去读。skill 工具加载正文时会给出 Skill 目录，模型拼出完整路径后用 read 读取。scripts/ 由 skill_run_script 在用户批准后运行，不能改用 bash 绕过
- assets/ 里的模板读出后照着填写，交付物再用 workspace_write 保存

## 业务会话里的工具

| 能力 | 工具 | 是否一定可用 |
|---|---|---|
| 当前时间 | current_time | 一般可用 |
| 会话工作区文件 | workspace_list / workspace_read / workspace_write | 一般可用 |
| 交付文件卡片 | workspace_present | 能写文件时可用 |
| 搜索文件 | glob / grep | 能读文件或关联了代码时可用 |
| 只读读取代码和 Skill 文件 | read | 关联了代码或 Skill 有附加文件时可用 |
| Skill 脚本 | skill_run_script | 仅启用脚本能力的业务会话可用；每次调用要用户批准，隔离环境中运行 |
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
- 附加文件：references/ 只能放 .md、.txt；assets/ 能放 .md、.txt、.json、.csv、.yaml、.html；scripts/ 只能放 .py、.js、.sh。每个目录只有一层，不能再建子目录
- 文件名：英文字母或数字开头，只能包含字母、数字、点、下划线、短横线
- 数量和大小：最多 20 个文件，单个不超过 120KB，合计不超过 512KB；业务会话中只读
- 编写会话可用 skill_test_script 在隔离环境试运行脚本；部署环境未提供隔离运行能力时会拒绝执行
- Skill 工作台可同时使用草稿编辑工具和当前草稿的 skill / read / skill_run_script。skill_test_script 只检查单个脚本，不代表完整 Skill 已完成任务
