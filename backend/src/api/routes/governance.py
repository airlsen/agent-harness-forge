from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from ..core.database import get_session
from ..models.platform import PlatformSetting
from ..services.file_service import file_service
from ..services.runner_client import runner_client
from ..services.capability_service import (
    WebSearchInput,
    reveal_web_key,
    save_web_settings,
    web_settings_view,
)
from ..services.settings_service import PolicyInput, get_policy
from ..utils.response import ResponseUtil

router = APIRouter()


@router.get("/policies")
async def policies(db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(
        {
            **(await get_policy(db)),
            "scope": "single-workspace",
            "shellEnabled": False,
            # 联网（web_search / web_fetch）由下方 /web-search 设置控制，场景或聊天开启后才装配
            "networkToolsEnabled": (await web_settings_view(db))["available"],
            "notice": "工具与执行限额只影响新建会话，现有会话继续使用其不可变策略快照；文件保留期限对所有会话即时生效。",
        }
    )


@router.put("/policies")
async def save(payload: PolicyInput, db: AsyncSession = Depends(get_session)):
    row = await db.get(PlatformSetting, "policy")
    if not row:
        row = PlatformSetting(key="policy", value=payload.model_dump())
        db.add(row)
    else:
        row.value = payload.model_dump()
    await db.commit()
    return ResponseUtil.ok(await get_policy(db))


@router.get("/web-search")
async def web_search(db: AsyncSession = Depends(get_session)):
    """联网搜索设置：密钥加密保存，这里不回传；需要查看时走 POST /web-search/key。"""
    return ResponseUtil.ok(await web_settings_view(db))


@router.put("/web-search")
async def save_web_search(payload: WebSearchInput, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await save_web_settings(db, payload))


@router.post("/web-search/key")
async def reveal_web_search_key(db: AsyncSession = Depends(get_session)):
    """查看已保存的联网搜索密钥（设置页点击眼睛图标）。"""
    return ResponseUtil.ok({"apiKey": await reveal_web_key(db)})


@router.get("/storage")
async def storage(db: AsyncSession = Depends(get_session)):
    """会话文件存储概况：文件数、逻辑大小、去重后实际占用、保留期限与最近一次清理结果。"""
    return ResponseUtil.ok(await file_service.stats(db))


@router.post("/storage/cleanup")
async def cleanup():
    """立即按当前保留期限清理过期会话文件，并回收不再引用的内容。"""
    return ResponseUtil.ok(await file_service.cleanup_expired(runner_client))


class CodeRootInput(BaseModel):
    root: str = Field(default="", max_length=1024)


async def code_root_view(root: str) -> dict:
    """检查代码目录：是否存在、下面有多少个项目（一级子目录）。"""
    listing = await runner_client.code_projects(root)
    projects = [project["name"] for project in listing.get("projects", [])]
    return {
        "root": root,
        "effectiveRoot": listing.get("root", ""),
        "available": bool(listing.get("available")),
        "count": len(projects),
        "projects": projects[:20],
    }


@router.get("/code-root")
async def code_root():
    """关联代码目录：当前设置与检查结果；空表示使用 Runner 的 FORGE_CODE_ROOT。"""
    return ResponseUtil.ok(await code_root_view(runner_client.code_root))


@router.post("/code-root/check")
async def check_code_root(payload: CodeRootInput):
    """只检查，不保存。"""
    return ResponseUtil.ok(await code_root_view(payload.root.strip()))


@router.put("/code-root")
async def save_code_root(payload: CodeRootInput, db: AsyncSession = Depends(get_session)):
    """保存关联代码目录：目录必须存在；留空恢复默认。工作台列表与下一轮对话起生效。"""
    root = payload.root.strip()
    view = await code_root_view(root)
    if root and not view["available"]:
        raise HTTPException(422, "路径不存在或不是目录，不能添加")
    row = await db.get(PlatformSetting, "codeRoot")
    if row:
        row.value = {"root": root}
    else:
        db.add(PlatformSetting(key="codeRoot", value={"root": root}))
    await db.commit()
    runner_client.code_root = root
    return ResponseUtil.ok(view)
