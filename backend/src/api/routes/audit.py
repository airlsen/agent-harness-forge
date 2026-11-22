from fastapi import APIRouter
from ..services.session_service import session_service
from ..utils.response import ResponseUtil

router = APIRouter()


@router.get("/sessions")
async def sessions(
    query: str = "", scenario_id: int | None = None, status: str | None = None, space_id: int | None = None
):
    # 审计是全局的：默认全部空间，可按空间筛选
    rows = await session_service.list(include_tests=True, include_archived=True, space_id=space_id)
    if query:
        rows = [r for r in rows if query.lower() in (r["title"] + r["scenarioName"] + str(r["id"])).lower()]
    if scenario_id:
        rows = [r for r in rows if r["scenarioId"] == scenario_id]
    if status:
        rows = [r for r in rows if r["status"] == status]
    return ResponseUtil.ok(
        {
            "items": rows,
            "summary": {
                "sessions": len(rows),
                "tokens": sum(r["tokensIn"] + r["tokensOut"] for r in rows),
                "errors": sum(r["status"] == "error" for r in rows),
            },
        }
    )


@router.get("/sessions/{session_id}/replay")
async def replay(session_id: int):
    return ResponseUtil.ok(
        {
            **(await session_service.detail(session_id)),
            "events": await session_service.all_events(session_id),
            "readOnly": True,
        }
    )
