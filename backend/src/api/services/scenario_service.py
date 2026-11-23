from dataclasses import asdict
from datetime import timezone
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..models.agent_scenario import AgentScenario, AgentScenarioVersion
from ..models.platform import PlatformSetting
from ..schemas.agent_scenario import ScenarioPayload
from .scenario_assembler import Bundle, ScenarioAssembler
from .settings_service import get_policy, environment_ref
from .space_service import PUBLIC_SPACE_ID, attach_space, space_map, target_space, visible_filter


def iso(dt):
    return (
        dt.replace(tzinfo=timezone.utc).isoformat()
        if dt and dt.tzinfo is None
        else dt.isoformat()
        if dt
        else None
    )


class ScenarioService:
    assembler = ScenarioAssembler()

    async def row(self, db, scenario_id):
        row = await db.get(AgentScenario, scenario_id)
        if not row or row.status == "deleted":
            raise HTTPException(404, "场景不存在")
        return row

    async def version(self, db, row, version_number=None):
        number = row.current_version if version_number is None else version_number
        value = await db.scalar(
            select(AgentScenarioVersion).where(
                AgentScenarioVersion.scenario_id == row.id,
                AgentScenarioVersion.version == number,
            )
        )
        if not value:
            raise HTTPException(409, "场景缺少有效版本")
        return value

    async def view(self, db, row, spaces=None):
        version = await self.version(db, row)
        published = None
        if row.published_version:
            published = (
                version
                if row.published_version == row.current_version
                else await self.version(db, row, row.published_version)
            )
        tested = await db.get(PlatformSetting, f"scenario-test:{row.id}:{row.current_version}")
        view = {
            "id": row.id,
            "space": row.space,
            "owner_id": row.owner_id,
            "status": row.status,
            "current_version": row.current_version,
            "published_version": row.published_version,
            "published_payload": published.bundle_json["payload"] if published else None,
            "published_bundle_hash": published.bundle_hash if published else None,
            "payload": version.bundle_json["payload"],
            "bundleHash": version.bundle_hash,
            "tested": bool(
                tested
                and tested.value.get("ok")
                and tested.value.get("environmentRef") == await environment_ref(db)
            ),
            "createdAt": iso(row.created_at),
            "updatedAt": iso(row.updated_at),
            "publishedAt": iso(row.published_at) if row.published_version else None,
        }
        # 所属空间：前端显示「公共」标记、分组与「移动到…」
        return attach_space(view, row.space_id, spaces if spaces is not None else await space_map(db))

    async def list_mine(self, db, owner_id="admin", space_id=None):
        """场景列表：传入当前空间时只列本空间 + 公共空间的场景。"""
        rows = (
            await db.scalars(
                select(AgentScenario)
                .where(AgentScenario.status != "deleted", visible_filter(AgentScenario.space_id, space_id))
                .order_by(AgentScenario.space, AgentScenario.id)
            )
        ).all()
        spaces = await space_map(db)
        return [await self.view(db, row, spaces) for row in rows]

    async def create(
        self, db: AsyncSession, owner_id: str, payload: ScenarioPayload, *, official=False, space_id=None
    ):
        payload = ScenarioPayload.model_validate(payload.model_dump())
        # 官方模板放在公共空间；其他场景放在当前空间（未指定时为公共）
        space = PUBLIC_SPACE_ID if official else target_space(space_id)
        bundle = await self.assembler.compile(
            db,
            payload,
            tenant_policy=await get_policy(db),
            rendered_prompt=payload.prompt_template,
            space_id=space,
        )
        row = AgentScenario(
            space_id=space,
            tenant_id="sandbox",
            owner_id=owner_id,
            space="official" if official else "personal",
            name=payload.name.strip(),
            description=payload.description,
            icon=payload.icon,
            status="template" if official else "draft",
            current_version=1,
            published_version=0,
        )
        db.add(row)
        await db.flush()
        db.add(
            AgentScenarioVersion(
                scenario_id=row.id,
                version=1,
                bundle_json={"payload": payload.model_dump(), "bundle": asdict(bundle)},
                bundle_hash=bundle.bundle_hash,
                created_by=owner_id,
                change_log="初始化场景",
            )
        )
        await db.commit()
        await db.refresh(row)
        return await self.view(db, row)

    async def update(self, db, owner_id, scenario_id, payload):
        row = await self.row(db, scenario_id)
        self.editable(row, owner_id)
        clean = ScenarioPayload.model_validate(payload.model_dump())
        bundle = await self.assembler.compile(
            db,
            clean,
            tenant_policy=await get_policy(db),
            rendered_prompt=clean.prompt_template,
            space_id=row.space_id or PUBLIC_SPACE_ID,
        )
        row.name, row.description, row.icon = clean.name.strip(), clean.description, clean.icon
        row.current_version += 1
        if not row.published_version:
            row.status = "draft"
        db.add(
            AgentScenarioVersion(
                scenario_id=row.id,
                version=row.current_version,
                bundle_json={"payload": clean.model_dump(), "bundle": asdict(bundle)},
                bundle_hash=bundle.bundle_hash,
                created_by=owner_id,
                change_log=getattr(payload, "change_log", "") or "更新配置",
            )
        )
        await db.commit()
        await db.refresh(row)
        return await self.view(db, row)

    def editable(self, row, owner):
        if row.space == "official":
            raise HTTPException(403, "官方模板只读，请先复制为我的场景")
        if row.owner_id != owner:
            raise HTTPException(403, "无权修改此场景")

    async def delete(self, db, owner_id, scenario_id):
        row = await self.row(db, scenario_id)
        self.editable(row, owner_id)
        row.status = "deleted"
        await db.commit()

    async def versions(self, db, scenario_id):
        row = await self.row(db, scenario_id)
        versions = (
            await db.scalars(
                select(AgentScenarioVersion)
                .where(AgentScenarioVersion.scenario_id == row.id)
                .order_by(AgentScenarioVersion.version.desc())
            )
        ).all()
        return [
            {
                "version": v.version,
                "bundleHash": v.bundle_hash,
                "changeLog": v.change_log,
                "createdAt": iso(v.created_at),
                "payload": v.bundle_json["payload"],
                # Bundle 是已发布版本的不可变装配结果；不包含模型凭据或外部密钥。
                "bundle": v.bundle_json.get("bundle", {}),
            }
            for v in versions
        ]


scenario_service = ScenarioService()


# 通用助手默认绑定联网搜索：日常问答常需要最新信息。平台未开启联网时该项标为「未生效」，不影响对话。
GENERAL_ASSISTANT = "通用助手"
# 提示词中的联网说明：联网统一走 web_search / web_fetch（受治理中心管控），不用命令行访问网站。
WEB_SEARCH_HINT = (
    "需要最新信息或外部资料时，使用联网搜索工具查询并注明来源；不要用命令行（如 curl）访问网站。"
)


async def ensure_general_assistant_web(db) -> None:
    """为已部署环境的预置「通用助手」补上联网搜索（幂等）：各版本的配置与能力快照都开启联网并补充提示词。

    预置场景只读，且只在空库时创建一次，因此需要在启动时补齐。
    """
    rows = (
        await db.scalars(
            select(AgentScenario).where(
                AgentScenario.space == "official", AgentScenario.name == GENERAL_ASSISTANT
            )
        )
    ).all()
    for row in rows:
        versions = (
            await db.scalars(select(AgentScenarioVersion).where(AgentScenarioVersion.scenario_id == row.id))
        ).all()
        for version in versions:
            data = version.bundle_json
            if not isinstance(data, dict) or not isinstance(data.get("payload"), dict):
                continue
            payload = dict(data["payload"])
            capabilities = dict(payload.get("capabilities") or {})
            prompt = str(payload.get("prompt_template") or "")
            bundle = data.get("bundle")
            meta = (bundle or {}).get("meta") if isinstance(bundle, dict) else None
            if (
                capabilities.get("web_search")
                and WEB_SEARCH_HINT in prompt
                and (not isinstance(meta, dict) or meta.get("webSearch"))
            ):
                continue
            capabilities["web_search"] = True
            payload["capabilities"] = capabilities
            if WEB_SEARCH_HINT not in prompt:
                payload["prompt_template"] = f"{prompt}{WEB_SEARCH_HINT}"
            updated = {**data, "payload": payload}
            if isinstance(bundle, dict) and isinstance(meta, dict):
                bundle = {**bundle, "meta": {**meta, "webSearch": True}}
                system_prompt = (bundle.get("profile_patch") or {}).get("systemPrompt")
                if isinstance(system_prompt, dict):
                    domain = str(system_prompt.get("domain") or "")
                    if WEB_SEARCH_HINT not in domain:
                        bundle["profile_patch"] = {
                            **bundle["profile_patch"],
                            "systemPrompt": {**system_prompt, "domain": f"{domain}{WEB_SEARCH_HINT}"},
                        }
                updated["bundle"] = bundle
                try:
                    version.bundle_hash = Bundle.from_dict(bundle).bundle_hash
                except TypeError:
                    pass  # 早期快照字段不全：仅更新内容，摘要保持原值
            version.bundle_json = updated
    await db.commit()


async def seed_scenarios(db):
    if await db.scalar(select(AgentScenario.id).limit(1)):
        await ensure_general_assistant_web(db)
        return
    templates = [
        (
            GENERAL_ASSISTANT,
            "日常问答、思路梳理与任务拆解，让复杂工作有一个清晰起点。",
            "sparkles",
            "你是一位严谨而友好的工作助手。先理解用户目标，必要时澄清问题，再提供清晰、可执行的回答。用户需要文件时保存到工作区。"
            + WEB_SEARCH_HINT,
            ["current_time", "workspace_list", "workspace_read", "workspace_write", "bash"],
        ),
        (
            "代码与研发",
            "读懂代码、定位问题、设计方案，与你一起推进研发任务。",
            "code",
            "你是一位资深软件工程师。根据用户提供的代码进行分析、调试与设计。区分事实与推测，不声称执行未经工具验证的代码。可在授权后生成代码或说明文档到工作区。",
            ["workspace_list", "workspace_read", "workspace_write", "bash"],
        ),
        (
            "文档与报告",
            "从零散资料到结构化文档，让写作、总结和交付更高效。",
            "file",
            "你是一位专业文档与报告助手。依据用户提供的内容组织结构，标注缺失信息，避免编造事实。输出可阅读的 Markdown；用户需要文件时，先说明产物，再调用授权工具保存。",
            ["current_time", "workspace_list", "workspace_read", "workspace_write"],
        ),
        (
            "分析与决策",
            "拆解业务问题、梳理对比维度，形成有依据的行动建议。",
            "chart",
            "你是一位严谨的分析助手。基于用户提供的数据和事实进行分析，区分假设与结论，给出计算依据、风险和可执行建议。不要编造外部数据或声称访问不存在的数据源。",
            ["current_time", "workspace_list", "workspace_read", "workspace_write"],
        ),
    ]
    for name, description, icon, prompt, tools in templates:
        await scenario_service.create(
            db,
            "system",
            ScenarioPayload(
                name=name,
                description=description,
                icon=icon,
                prompt_template=prompt,
                capabilities={
                    "plugin_names": ["forge-runtime"],
                    "builtin_tool_names": tools,
                    "web_search": name == GENERAL_ASSISTANT,
                },
            ),
            official=True,
        )
