"""通用定时任务：按间隔反复执行，单次失败不影响后续，服务停止时全部退出。"""

import asyncio

import pytest

from src.api.services import scheduler as scheduler_module
from src.api.services.scheduler import Job, Scheduler


@pytest.mark.asyncio
async def test_failed_run_is_logged_and_next_run_continues(caplog):
    calls = []

    async def flaky():
        calls.append(len(calls))
        if len(calls) == 1:
            raise RuntimeError("第一次失败")

    jobs = Scheduler()
    jobs.start([Job("测试任务", flaky, interval=0.01)])
    for _ in range(100):
        if len(calls) >= 3:
            break
        await asyncio.sleep(0.01)
    await jobs.stop()

    assert len(calls) >= 3
    assert "定时任务「测试任务」执行失败" in caplog.text
    assert jobs.tasks == []


@pytest.mark.asyncio
async def test_stop_cancels_waiting_jobs_and_start_is_idempotent():
    async def never_runs():
        raise AssertionError("首次延迟内不应执行")

    jobs = Scheduler()
    jobs.start([Job("延迟任务", never_runs, interval=60, delay=60)])
    first = list(jobs.tasks)
    jobs.start([Job("延迟任务", never_runs, interval=60, delay=60)])
    assert jobs.tasks == first
    await jobs.stop()
    assert all(task.cancelled() for task in first)


def test_builtin_jobs_include_keepalive_every_minute():
    jobs = {job.name: job for job in scheduler_module.JOBS}
    assert jobs["服务保活"].interval == 60
    assert jobs["会话文件过期清理"].interval >= 60
