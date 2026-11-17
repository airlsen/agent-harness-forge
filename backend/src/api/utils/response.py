"""统一响应包装（沿用旧 AgentX 的 ApiResponse[T] 契约）。

所有 route 返回 ResponseUtil.ok(data) / ResponseUtil.fail(code, message)。
"""

from typing import Generic, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class ApiResponse(BaseModel, Generic[T]):
    code: int = 0
    message: str = "ok"
    data: T | None = None


class ResponseUtil:
    @staticmethod
    def ok(data: T | None = None, message: str = "ok") -> ApiResponse[T]:
        return ApiResponse(code=0, message=message, data=data)

    @staticmethod
    def fail(code: int, message: str) -> ApiResponse[None]:
        return ApiResponse(code=code, message=message, data=None)
