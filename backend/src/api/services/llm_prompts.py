"""提示词任务登记表：每个使用 AI 的功能在这里登记一个任务，由 ``llm_service.run_task`` 调用。

新增一个 AI 功能的步骤：
1. 在下方用 ``register(PromptTask(...))`` 登记任务：名称、系统提示词、用户提示词模板、输出格式；
2. 业务代码里调用 ``llm_service.run_task(db, "任务名", {变量})``，JSON 任务会自动解析与重试。

模板变量写作 ``$name``（string.Template 语法），提示词里的 JSON 花括号无需转义。
"""

from __future__ import annotations

from dataclasses import dataclass
from string import Template
from typing import Any

from fastapi import HTTPException


@dataclass(frozen=True)
class PromptTask:
    name: str
    system: str
    user: str
    # 输出 JSON 对象时为 True：自动要求结构化输出并解析
    json: bool = False
    temperature: float = 0.3
    max_tokens: int = 2048

    def render(self, variables: dict[str, Any]) -> list[dict]:
        values = {key: "" if value is None else str(value) for key, value in variables.items()}
        return [
            {"role": "system", "content": Template(self.system).safe_substitute(values)},
            {"role": "user", "content": Template(self.user).safe_substitute(values)},
        ]


_TASKS: dict[str, PromptTask] = {}


def register(task: PromptTask) -> PromptTask:
    _TASKS[task.name] = task
    return task


def get_task(name: str) -> PromptTask:
    task = _TASKS.get(name)
    if not task:
        raise HTTPException(404, f"未登记的 AI 任务：{name}")
    return task


def task_names() -> list[str]:
    return sorted(_TASKS)


# —— 场景生成：新建 / 编辑场景时，按需求生成名称、介绍、图标、提示词，并从可选能力中匹配 ——

SCENARIO_GENERATE = register(
    PromptTask(
        name="scenario.generate",
        json=True,
        temperature=0.4,
        max_tokens=4096,
        system="""你是企业智能体平台的「场景设计助手」。
场景是一组预置的提示词和能力（Skill、MCP 服务、插件工具、联网搜索）；用户选择场景后，在对话中让智能体完成某一类工作。
请根据用户需求和当前草稿，生成场景配置。规则：
1. 只输出一个 JSON 对象，不要输出解释文字，也不要用 Markdown 代码块包裹。
2. 只生成「需要生成的字段」中列出的字段，其余字段不要输出。
3. 能力只能从「可选能力清单」中按 ref 选择，不得编造；只选完成这类工作确实需要的，宁少勿多；每项附一句中文理由（不超过 40 字）。
4. 插件要同时给出要用的工具名（tools），只能从该插件的工具中选；demo 为 true 的插件只返回模拟数据，除非用户明确要演示，否则不要选。
5. 清单中没有、但这类工作明显需要的能力，写进 missing（最多 3 条），不要用不相关的能力凑数。
6. 平台基础工具（读写工作区文件、查询时间、命令行等）每个场景都自带，不需要选择，也不要写进 missing。
7. 名称不超过 20 字；介绍是一句话，不超过 60 字，说明适合做什么工作；图标只能从 $icons 中选一个。
8. 提示词用中文 Markdown，依次包含：## 角色、## 目标、## 工作步骤、## 输出要求、## 注意事项；在工作步骤里写明什么时候使用哪个已选能力（用能力名称称呼）；不超过 1500 字。
   提示词只写做什么、交付什么格式（如 Markdown 报告、Excel 表格、Word 文档），不要写具体的终端写法，例如"先 cd 到某目录再执行"、用 echo 或 cat 写文件；终端每次调用都是独立的，文件读写和生成方式由平台另行告知智能体。
9. 编辑已有场景时，保留草稿中仍然合适的内容和能力，只做必要的调整。

输出格式（只包含需要生成的字段）：
{
  "name": "场景名称",
  "description": "一句话介绍",
  "icon": "图标名",
  "prompt": "场景提示词（Markdown）",
  "capabilities": {
    "skills": [{"ref": "S1", "reason": "理由"}],
    "mcp": [{"ref": "M1", "reason": "理由"}],
    "plugins": [{"ref": "P1", "tools": ["工具名"], "reason": "理由"}],
    "web_search": {"enabled": true, "reason": "理由"}
  },
  "missing": [{"name": "缺少的能力", "reason": "为什么需要"}]
}""",
        user="""需要生成的字段：$fields

用户需求：
$requirement

当前草稿：
$draft

可选能力清单：
$catalog""",
    )
)
