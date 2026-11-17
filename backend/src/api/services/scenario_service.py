"""场景服务：CRUD / AI 生成 / 试运行 / 发布（V1）。

沿用旧方案交互语义：generate 不落库，只回草稿；发布后版本不可变。
"""

from sqlalchemy.ext.asyncio import AsyncSession

from ..models.agent_scenario import AgentScenario, AgentScenarioVersion
from ..schemas.agent_scenario import GenerateScenarioRequest, ScenarioPayload
from .runner_client import runner_client
from .scenario_assembler import ScenarioAssembler


class ScenarioService:
    def __init__(self) -> None:
        self.assembler = ScenarioAssembler()

    async def list_mine(self, db: AsyncSession, owner_id: str) -> list[AgentScenario]:
        # TODO(M1): select where owner_id=:owner and space='personal'
        return []

    async def create(self, db: AsyncSession, owner_id: str, payload: ScenarioPayload) -> AgentScenario:
        # TODO(M1): 写 agent_scenario + agent_scenario_version(v1) + bundle_hash
        raise NotImplementedError

    async def update(self, db: AsyncSession, owner_id: str, scenario_id: int, payload: ScenarioPayload) -> None:
        # TODO(M1): 校验归属；产生新版本行（不可变），推进 current_version
        raise NotImplementedError

    async def delete(self, db: AsyncSession, owner_id: str, scenario_id: int) -> None:
        raise NotImplementedError

    async def generate(self, db: AsyncSession, owner_id: str, req: GenerateScenarioRequest) -> ScenarioPayload:
        """AI 生成草稿（不落库）。

        与旧方案的差异：不再"拼 prompt 调模型"，而是创建一个临时 dsh Creative 模式
        会话，把描述 + 能力目录喂给它，在内存里试装插件验证组合后产出装配单。
        """
        capability_catalog = []  # TODO(M1): registry 服务汇总插件/Skill/MCP/工具能力目录
        _ = await runner_client  # 占位：create_session(mode='creative') -> send_turn(description+catalog)
        raise NotImplementedError("见 docs/02-技术方案 §五：Creative 模式生成链路")

    async def run_test(self, db: AsyncSession, owner_id: str, scenario_id: int) -> dict:
        """试运行：沙箱会话跑通一次才允许保存/发布（质量红线）。"""
        raise NotImplementedError


scenario_service = ScenarioService()
