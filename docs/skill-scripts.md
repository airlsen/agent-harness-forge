# Skill 脚本运行

Skill 可以包含 `scripts/*.py`、`scripts/*.js`、`scripts/*.sh`。编写窗口的助手用 `skill_write_file` 保存，使用 `skill_test_script` 试运行；下载 ZIP 和发布修订会保留脚本。业务会话只能运行已授权 Skill 的脚本，通过 `skill_run_script` 调用，每次调用需用户批准，平台策略中的“运行 Skill 脚本”可关闭此能力。

Runner 必须运行在 Linux，安装 `bubblewrap`（命令 `bwrap`），并允许创建用户、挂载、网络和 PID 命名空间。脚本执行时仅挂载只读 Skill 文件（本轮装配的修订快照目录 `DATA/<会话>/skills/<名称>/<修订号>-<内容哈希>/`，含 `SKILL.md` 与全部附加文件，挂载为 `/skill/current`）、只读系统解释器及库、独立临时工作目录；无网络、无宿主环境变量。单次限 10 秒、16 个参数、64 KB 输出。缺少 `bwrap` 或命名空间被宿主策略禁止时，试运行与业务调用会明确报错，不退回到普通 Shell。部署后先用一个无副作用的脚本验证宿主是否支持隔离运行。

脚本的输入通过 `args` 传递；输出写 stdout，错误写 stderr，失败用非零退出码。脚本不得依赖 pip/npm 安装包、外部网络或宿主文件。Skill 正文应明确何时运行、参数含义和失败时如何处理；用户拒绝调用后不应使用 bash 绕过。普通 Skill 的业务效果测试与脚本试运行是两种不同的验证，后者只检查脚本本身。
