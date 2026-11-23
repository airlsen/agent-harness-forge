"""通用定时任务：随服务启动、停止，每个任务按固定间隔循环执行。

单次执行失败只记日志，不影响下一次执行，也不影响正常请求。
新增任务：写一个无参数的 async 函数，在 JOBS 里加一行 Job 即可。
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from sqlalchemy import text

from ..core.config import settings
from ..core.database import SessionFactory
from .file_service import file_service
from .runner_client import runner_client

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Job:
    name: str  # 中文名称，用于日志
    run: Callable[[], Awaitable[object]]
    interval: float  # 两次执行之间的间隔（秒），从上一次结束算起
    delay: float = 0  # 服务启动后首次执行前的等待（秒）


async def keepalive() -> None:
    """保活：查一次数据库并检查执行内核是否在线。

    让数据库连接保持活跃，避免长时间空闲后连接被防火墙、NAT 等网络设备静默断开，
    导致空闲后的第一个用户请求卡住变慢。
    """
    async with SessionFactory() as db:
        await db.execute(text("SELECT 1"))
    await runner_client.health()


async def cleanup_expired_files() -> None:
    """按保留期限清理过期的会话文件。"""
    await file_service.cleanup_expired(runner_client)


JOBS: list[Job] = [
    Job("服务保活", keepalive, interval=60, delay=60),
    Job(
        "会话文件过期清理",
        cleanup_expired_files,
        interval=max(60, settings.file_cleanup_interval_seconds),
        delay=60,
    ),
]


async def run_forever(job: Job) -> None:
    """按间隔反复执行一个任务；失败记日志后继续，只有服务停止（取消）时退出。"""
    await asyncio.sleep(job.delay)
    while True:
        try:
            await job.run()
        except Exception:
            log.exception("定时任务「%s」执行失败", job.name)
        await asyncio.sleep(job.interval)


class Scheduler:
    def __init__(self) -> None:
        self.tasks: list[asyncio.Task] = []

    def start(self, jobs: list[Job] = JOBS) -> None:
        """启动全部定时任务；已在运行时不重复启动。"""
        if self.tasks:
            return
        self.tasks = [asyncio.create_task(run_forever(job), name=f"定时任务：{job.name}") for job in jobs]

    async def stop(self) -> None:
        """停止全部定时任务，等待它们退出。"""
        tasks, self.tasks = self.tasks, []
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


scheduler = Scheduler()
