"""关联代码：列出代码根目录（Runner 的 FORGE_CODE_ROOT）下可供会话只读关联的项目。"""

from fastapi import APIRouter
from ..services.runner_client import runner_client
from ..utils.response import ResponseUtil

router = APIRouter()


@router.get("/projects")
async def projects():
    """项目由 Runner 读取（代码与 Runner 在同一台机器上），返回 {root, available, projects}。"""
    return ResponseUtil.ok(await runner_client.code_projects())
