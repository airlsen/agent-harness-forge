"""仅由隔离 API 测试调用，使用正式业务栈与显式的协议夹具，不接触用户工作空间。"""

import json
from pathlib import Path
from playwright.async_api import async_playwright, expect


async def check_execution_ui(
    base: str, username: str, password: str, output: Path, *, cookie_blocked=False
):
    checks, errors = [], []

    def passed(name):
        checks.append(name)
        print("PASS execution UI:", name)

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, args=["--no-sandbox"])
        page = await browser.new_page(viewport={"width": 1440, "height": 1000})
        page.on("pageerror", lambda error: errors.append(str(error)))
        try:
            await page.goto(base + "/agent/chat")
            await page.get_by_label("账号", exact=True).fill(username)
            await page.get_by_label("密码", exact=True).fill(password)
            await page.get_by_role("button", name="进入工作空间").click()
            await page.wait_for_selector(".app-shell")
            if cookie_blocked:
                assert not await page.context.cookies()
                assert await page.evaluate(
                    "Boolean(JSON.parse(sessionStorage.getItem('forge.preview-session.v1') || 'null')?.token)"
                )
                assert await page.evaluate(
                    "localStorage.getItem('forge.preview-session.v1') === null"
                )
            await page.locator(".scenario-trigger").click()
            await (
                page.locator(".scenario-popover>button")
                .filter(has_text="文档与报告")
                .click()
            )
            await page.get_by_label("任务输入").fill("HOLD reconnect fixture")
            await page.get_by_role("button", name="发送任务", exact=True).click()
            await expect(
                page.locator(".message-author").filter(has_text="正在输出")
            ).to_be_visible()
            sid = page.url.rsplit("/", 1)[-1]
            assert sid.isdigit(), page.url
            await page.get_by_role("link", name="场景中心", exact=True).click()
            await (
                page.locator(".recent-item>a")
                .filter(has_text="HOLD reconnect fixture")
                .click()
            )
            await expect(page.locator(".message-main .markdown-body")).to_contain_text(
                "Not a real model.", timeout=10000
            )
            await expect(page.locator(".message-row.assistant")).to_have_count(1)
            await expect(
                page.get_by_role("button", name="发送任务", exact=True)
            ).to_be_visible()
            passed(
                "leaving and returning to the same active session reattaches SSE without duplicate assistant messages"
            )
            await page.get_by_label("任务输入").fill("WRITE artifact fixture")
            await page.get_by_role("button", name="发送任务", exact=True).click()
            await expect(page.get_by_role("button", name="允许本次")).to_be_visible()
            await page.locator(".approval-card summary").click()
            await expect(page.locator(".approval-card pre")).to_contain_text(
                "result.md"
            )
            await page.get_by_role("button", name="允许本次").click()
            await expect(page.locator(".message-row.tool")).to_have_count(1)
            await expect(
                page.get_by_role("button", name="发送任务", exact=True)
            ).to_be_visible()
            await expect(page.locator(".message-row.tool")).to_contain_text("执行完成")
            passed(
                "real tool approval card controls actual workspace_write and persists the tool card"
            )
            await page.get_by_role("button", name="result.md").click()
            await expect(page.get_by_role("dialog", name="产物预览")).to_be_visible()
            await expect(page.locator(".file-preview>pre")).to_contain_text(
                "# API integration fixture"
            )
            async with page.expect_download() as captured:
                await page.get_by_role("button", name="下载文件", exact=True).click()
            artifact = await captured.value
            artifact_path = await artifact.path()
            assert (
                Path(artifact_path).read_text().startswith("# API integration fixture")
            )
            await page.get_by_role("button", name="完成", exact=True).click()
            passed(
                "actual generated file opens in preview and downloads with correct content"
            )
            await page.get_by_label("任务输入").fill("WRITE denied fixture")
            await page.get_by_role("button", name="发送任务", exact=True).click()
            await expect(
                page.get_by_role("button", name="拒绝", exact=True)
            ).to_be_visible()
            await page.get_by_role("button", name="拒绝", exact=True).click()
            await expect(page.locator(".message-row.tool")).to_have_count(2)
            await expect(page.locator(".message-row.tool").last).to_contain_text(
                "调用未成功"
            )
            await expect(
                page.get_by_role("button", name="发送任务", exact=True)
            ).to_be_visible()
            passed(
                "denied tool call renders an error result instead of successful execution"
            )
            await page.get_by_label("任务输入").fill("WRITE interrupt fixture")
            await page.get_by_role("button", name="发送任务", exact=True).click()
            await expect(page.get_by_role("button", name="允许本次")).to_be_visible()
            await page.get_by_role("button", name="中止", exact=True).click()
            await expect(page.locator(".approval-card")).to_have_count(0)
            await expect(page.locator(".form-alert.error")).to_contain_text("中止")
            await expect(
                page.get_by_role("button", name="发送任务", exact=True)
            ).to_be_visible()
            passed(
                "interruption closes pending approval and renders persistent failure state"
            )
            await page.reload()
            await page.wait_for_selector(".message-row.tool")
            await expect(page.locator(".message-row.tool")).to_have_count(2)
            await expect(page.locator(".form-alert.error")).to_contain_text("中止")
            passed(
                "page reload restores conversation, tool results, and last failure from database"
            )
            await page.goto(base + f"/agent/trajectory/{sid}")
            await expect(page.locator(".trajectory-event").first).to_be_visible()
            await page.get_by_role("button", name="工具", exact=True).click()
            await expect(page.locator(".trajectory-event").first).to_be_visible()
            await page.locator(".trajectory-event").first.locator("summary").click()
            await expect(
                page.locator(".trajectory-event").first.locator("pre")
            ).to_contain_text("workspace_write")
            async with page.expect_download() as captured:
                await page.get_by_role("button", name="导出会话证据").click()
            export = await captured.value
            exported = json.loads(Path(await export.path()).read_text())
            assert exported["id"] == int(sid) and any(
                event["kind"] == "approval_required" for event in exported["events"]
            )
            passed(
                "trajectory filtering, raw event expansion and authenticated JSON export work end to end"
            )
            assert not errors, errors
            passed("execution journeys produce no browser JavaScript exceptions")
            output.write_text(
                json.dumps(
                    {
                        "scope": "isolated protocol fixture, not real-model acceptance",
                        "result": "passed",
                        "cookiesBlocked": cookie_blocked,
                        "checks": len(checks),
                        "items": checks,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return checks
        finally:
            await browser.close()
