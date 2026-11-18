"""仅由隔离 API 测试调用，使用正式业务栈与显式的协议夹具，不接触用户工作空间。"""

import asyncio
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
        session_creates, interrupts, list_reads = [], [], []

        async def record_list_read(response):
            if response.request.method != "GET" or not response.url.endswith(
                "/api/agent/sessions"
            ):
                return
            try:
                rows = (await response.json())["data"]["items"]
                list_reads.append(
                    {
                        "at": asyncio.get_running_loop().time(),
                        "states": [
                            {"id": row["id"], "status": row["status"]}
                            for row in rows
                            if not row.get("isTest")
                        ],
                    }
                )
            except Exception:
                pass

        page.on("response", record_list_read)
        page.on(
            "request",
            lambda request: (
                session_creates.append(request.url)
                if request.method == "POST"
                and request.url.endswith("/api/agent/sessions")
                else interrupts.append(request.url)
                if request.method == "POST" and request.url.endswith("/interrupt")
                else None
            ),
        )
        try:
            await page.goto(base + "/agent/chat")
            await page.get_by_label("账号", exact=True).fill(username)
            await page.get_by_label("密码", exact=True).fill(password)
            await page.get_by_role("button", name="进入企业平台").click()
            await page.wait_for_selector(".app-shell")
            if cookie_blocked:
                assert not await page.context.cookies()
                assert await page.evaluate(
                    "Boolean(JSON.parse(sessionStorage.getItem('forge.preview-session.v1') || 'null')?.token)"
                )
                assert await page.evaluate(
                    "localStorage.getItem('forge.preview-session.v1') === null"
                )
            await expect(page.locator(".conversation-start-surface")).to_have_count(1)
            await expect(page.locator("h1")).to_have_text("今天要完成什么工作？")
            await expect(page.locator(".enterprise-composer-area")).to_have_count(0)
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
            await expect(page.locator(".conversation-start-surface")).to_have_count(0)
            await expect(page.locator(".conversation-start-suggestions")).to_have_count(
                0
            )
            await expect(
                page.locator(".enterprise-composer-area .task-composer")
            ).to_have_count(1)
            await expect(page.locator(".message-row.user")).to_have_count(1)
            assert len(session_creates) == 1
            passed(
                "new-chat first acceptance immediately opens its actual session and bottom composer without a second welcome or duplicate session"
            )
            await page.get_by_role("link", name="企业场景", exact=True).click()
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
            await expect(page.locator(".context-panel")).to_have_count(0)
            await page.get_by_role("button", name="查看结果", exact=True).click()
            async with page.expect_response(
                lambda response: "/file?path=result.md" in response.url
            ) as file_response:
                await page.get_by_role("button", name="result.md").click()
            fetched_file = await file_response.value
            await fetched_file.finished()
            assert fetched_file.status == 200
            await expect(page.get_by_role("dialog", name="产物预览")).to_be_visible()
            await expect(page.locator(".file-preview-content h1")).to_have_text(
                "API integration fixture"
            )
            await page.get_by_role("button", name="原文", exact=True).click()
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
            await page.get_by_role("button", name="关闭会话详情").click()
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
            for width, height in [(1440, 1000), (390, 844), (320, 720)]:
                await page.set_viewport_size({"width": width, "height": height})
                await page.locator(".trajectory-page").evaluate(
                    "element => { element.scrollTop = 0; }"
                )
                await expect(page.locator(".trajectory-page h1")).to_have_count(1)
                await expect(
                    page.get_by_role("link", name="返回审计中心", exact=True)
                ).to_be_visible()
                await expect(
                    page.get_by_role("button", name="导出会话证据", exact=True)
                ).to_be_visible()
                geometry = await page.evaluate(
                    """() => {
                        const main = document.querySelector('.trajectory-page');
                        const inner = main.querySelector('.enterprise-page-inner');
                        const view = document.querySelector('.enterprise-view');
                        const back = main.querySelector('.back-link');
                        const root = getComputedStyle(document.documentElement);
                        return {
                            viewY:view.getBoundingClientRect().y,
                            top:back.getBoundingClientRect().y,
                            expectedTop:parseFloat(root.getPropertyValue('--page-padding-top')),
                            contentX:inner.getBoundingClientRect().x,
                            headingX:main.querySelector('.page-heading').getBoundingClientRect().x,
                            snapshotWidth:main.querySelector('.snapshot-bar').getBoundingClientRect().width,
                            snapshotHeight:main.querySelector('.snapshot-bar').getBoundingClientRect().height,
                            snapshotContentWidth:main.querySelector('.snapshot-bar > div').getBoundingClientRect().width,
                            overflow:main.scrollWidth > main.clientWidth + 1,
                        };
                    }"""
                )
                assert abs(geometry["viewY"]) < 1, geometry
                assert abs(geometry["top"] - geometry["expectedTop"]) < 1, geometry
                assert abs(geometry["contentX"] - geometry["headingX"]) < 1, geometry
                assert not geometry["overflow"], geometry
                if width <= 480:
                    assert geometry["snapshotHeight"] < 230, geometry
                    assert (
                        geometry["snapshotContentWidth"]
                        > geometry["snapshotWidth"] * 0.55
                    ), geometry
                await page.screenshot(
                    path=str(output.parent / f"{output.stem}-trajectory-{width}.png")
                )
            await page.set_viewport_size({"width": 1440, "height": 1000})
            passed(
                "populated trajectory preserves its return link and export action on the shared grid without a topbar gap or desktop/phone overflow"
            )
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
            # Enterprise first-batch journeys, still against real control plane/Runner
            # and an explicitly isolated protocol fixture, never a substituted UI API.
            await page.goto(base + "/agent/workbench")
            await expect(page.locator(".workbench-page")).to_be_visible()
            creates_before_choice = len(session_creates)
            await page.get_by_role(
                "button", name="使用场景 文档与报告", exact=True
            ).click()
            await expect(page).to_have_url(base + "/agent/workbench")
            await expect(page.get_by_label("任务输入")).to_be_focused()
            assert len(session_creates) == creates_before_choice
            await page.locator("input[type=file]").set_input_files(
                {
                    "name": "notes.txt",
                    "mimeType": "text/plain",
                    "buffer": b"Isolated enterprise UI fixture",
                }
            )
            await page.get_by_label("任务输入").fill(
                "WRITE enterprise workbench fixture"
            )
            await page.get_by_role("button", name="发送任务", exact=True).click()
            await expect(page.get_by_role("button", name="允许本次")).to_be_visible()
            home_sid = page.url.rsplit("/", 1)[-1]
            assert home_sid.isdigit() and home_sid != sid
            assert len(session_creates) == creates_before_choice + 1
            await expect(page.locator(".conversation-start-surface")).to_have_count(0)
            await expect(
                page.locator(".enterprise-composer-area .task-composer")
            ).to_have_count(1)
            await expect(page.locator(".user-message-text")).to_contain_text(
                "Isolated enterprise UI fixture"
            )
            await expect(page.locator(".context-panel")).to_have_count(0)
            passed(
                "workbench composer submits real text attachments and opens the created conversation"
            )
            await page.set_viewport_size({"width": 390, "height": 844})
            await page.get_by_role("button", name="查看过程", exact=True).click()
            await expect(page.locator(".context-panel")).to_have_attribute(
                "aria-modal", "true"
            )
            await expect(page.locator(".chat-primary")).to_have_attribute("inert", "")
            for _ in range(8):
                await page.keyboard.press("Tab")
                assert await page.evaluate(
                    "document.querySelector('.context-panel').contains(document.activeElement)"
                )
            await page.keyboard.press("Escape")
            await expect(page.locator(".context-panel")).to_have_count(0)
            await page.get_by_role("button", name="允许本次").click()
            await expect(page.locator(".message-row.tool")).to_contain_text("执行完成")
            await expect(page.locator(".session-result-receipt")).to_be_visible()
            await page.locator(".session-result-receipt").click()
            await expect(page.locator(".artifact-file")).to_contain_text("result.md")
            await page.keyboard.press("Escape")
            passed(
                "mobile process drawer traps focus; approval still writes and results open only on request"
            )
            await page.set_viewport_size({"width": 1440, "height": 1000})
            await page.get_by_label("任务输入").fill(
                "Unsent draft for this conversation only"
            )
            await page.locator("input[type=file]").set_input_files(
                {
                    "name": "reply.txt",
                    "mimeType": "text/plain",
                    "buffer": b"Only this existing conversation",
                }
            )
            interrupts_before_home = len(interrupts)
            await page.get_by_role("link", name="工作台", exact=True).click()
            await expect(page.get_by_label("任务输入")).to_have_value("")
            await expect(page.locator(".attachment-chips")).to_have_count(0)
            await page.get_by_label("任务输入").fill(
                "Independent task draft on the workbench"
            )
            await page.locator("input[type=file]").set_input_files(
                {
                    "name": "start.txt",
                    "mimeType": "text/plain",
                    "buffer": b"Only the new task",
                }
            )
            await page.get_by_role(
                "button", name="使用场景 分析与决策", exact=True
            ).click()
            await page.locator(
                f'.enterprise-recent-item>a[href="/agent/chat/{sid}"]'
            ).click()
            await expect(page.locator(".chat-title>strong")).to_contain_text(
                "HOLD reconnect fixture"
            )
            await expect(page.get_by_label("任务输入")).to_have_value("")
            await expect(page.locator(".attachment-chips")).to_have_count(0)
            await page.get_by_label("任务输入").fill("Reply only for the first session")
            await page.locator(
                f'.enterprise-recent-item>a[href="/agent/chat/{home_sid}"]'
            ).click()
            await expect(page.get_by_label("任务输入")).to_have_value(
                "Unsent draft for this conversation only"
            )
            await expect(page.locator(".attachment-chips")).to_contain_text("reply.txt")
            await expect(page.locator(".attachment-chips")).not_to_contain_text(
                "start.txt"
            )
            await page.locator(
                f'.enterprise-recent-item>a[href="/agent/chat/{sid}"]'
            ).click()
            await expect(page.get_by_label("任务输入")).to_have_value(
                "Reply only for the first session"
            )
            await expect(page.locator(".attachment-chips")).to_have_count(0)
            await page.get_by_role("link", name="工作台", exact=True).click()
            await expect(page.get_by_label("任务输入")).to_have_value(
                "Independent task draft on the workbench"
            )
            await expect(page.locator(".attachment-chips")).to_contain_text("start.txt")
            await expect(page.locator(".scenario-trigger")).to_contain_text(
                "分析与决策"
            )
            assert len(interrupts) == interrupts_before_home
            passed(
                "workbench task and two conversation reply drafts restore their own text/files/scenario only, with no context mixing or interrupt request"
            )
            await page.locator(".enterprise-new-chat").click()
            confirmation = page.get_by_role("dialog", name="新建会话确认", exact=True)
            await expect(confirmation).to_be_visible()
            await page.keyboard.press("Escape")
            await expect(page.get_by_label("任务输入")).to_have_value(
                "Independent task draft on the workbench"
            )
            await page.locator(".enterprise-new-chat").click()
            await confirmation.get_by_role(
                "button", name="放弃草稿并新建", exact=True
            ).click()
            await expect(page.get_by_label("任务输入")).to_have_value("")
            await page.locator(
                f'.enterprise-recent-item>a[href="/agent/chat/{home_sid}"]'
            ).click()
            await expect(page.get_by_label("任务输入")).to_have_value(
                "Unsent draft for this conversation only"
            )
            await expect(page.locator(".attachment-chips")).to_contain_text("reply.txt")
            passed(
                "explicit new-task discard clears only that starting draft, not parked existing-conversation replies"
            )
            await page.get_by_role("link", name="我的会话", exact=True).click()
            await page.get_by_label("搜索会话").fill("enterprise workbench fixture")
            await expect(page.locator(".conversation-table-row")).to_have_count(1)
            await expect(
                page.locator(".conversation-table-row .session-state")
            ).to_have_text("可继续")
            await (
                page.locator(".conversation-table-actions")
                .get_by_role("link", name="打开", exact=True)
                .click()
            )
            await expect(page.locator(".message-row.user")).to_have_count(1)
            await expect(page.get_by_label("任务输入")).to_have_value(
                "Unsent draft for this conversation only"
            )
            await expect(page.locator(".attachment-chips")).to_contain_text("reply.txt")
            await page.get_by_role(
                "button", name="移除附件 reply.txt", exact=True
            ).click()
            passed(
                "real conversation search retains settled-not-success state and restores only the reopened session's own reply draft"
            )
            await page.get_by_label("任务输入").fill(
                "HOLD navigation during submit fixture"
            )

            turn_release, turn_requested = asyncio.Event(), asyncio.Event()

            async def delay_turn(route):
                turn_requested.set()
                await turn_release.wait()
                await route.continue_()

            await page.route("**/api/agent/sessions/*/turns", delay_turn)
            try:
                await page.get_by_role("button", name="发送任务", exact=True).click()
                await asyncio.wait_for(turn_requested.wait(), timeout=5)
                await page.locator(".enterprise-new-chat").click()
                await expect(page).to_have_url(base + "/agent/chat")
                await page.get_by_label("任务输入").fill(
                    "A newer draft must survive the late receipt"
                )
                await page.locator("input[type=file]").set_input_files(
                    {
                        "name": "newer.txt",
                        "mimeType": "text/plain",
                        "buffer": b"Never attach this to the old turn",
                    }
                )
                async with page.expect_response(
                    lambda response: (
                        "/turns" in response.url and response.request.method == "POST"
                    )
                ):
                    turn_release.set()
            finally:
                turn_release.set()
                await page.unroute_all(behavior="wait")
            await expect(page).to_have_url(base + "/agent/chat")
            await expect(page.locator(".message-row")).to_have_count(0)
            await expect(page.get_by_label("任务输入")).to_have_value(
                "A newer draft must survive the late receipt"
            )
            await expect(page.locator(".attachment-chips")).to_contain_text("newer.txt")
            assert len(interrupts) == interrupts_before_home
            passed(
                "late in-flight turn receipt cannot redirect, overwrite, clear, or populate a newer draft and its attachment"
            )
            await page.get_by_role("link", name="我的会话", exact=True).click()
            await page.get_by_label("搜索会话").fill("enterprise workbench fixture")
            await page.get_by_role("button", name="刷新会话").click()
            # The HOLD turn is accepted in the background and settles independently.
            await expect(
                page.locator(".conversation-table-row .session-state")
            ).to_have_text("执行中")
            await expect(
                page.locator(".conversation-table-actions button")
            ).to_be_disabled()
            await (
                page.locator(".conversation-table-actions")
                .get_by_role("link", name="打开", exact=True)
                .click()
            )
            await expect(page.locator(".message-row.assistant")).to_have_count(
                2, timeout=10000
            )
            await page.get_by_role("link", name="我的会话", exact=True).click()
            await page.get_by_label("搜索会话").fill("enterprise workbench fixture")
            # We deliberately leave while the second answer is still streaming:
            # the fixture holds for 3s, then the background list polls every 3s.
            # A 5s default assertion can expire just before the next legitimate poll.
            await expect(
                page.locator(".conversation-table-row .session-state")
            ).to_have_text("可继续", timeout=10000)
            await expect(
                page.locator(".conversation-table-actions button")
            ).to_be_enabled()
            await page.locator(".conversation-table-actions button").click()
            await expect(
                page.get_by_role("dialog", name="归档会话确认")
            ).to_be_visible()
            await page.get_by_role("button", name="确认归档", exact=True).click()
            await expect(page.locator(".conversation-table-row")).to_have_count(0)
            passed(
                "running sessions cannot be archived; settled-session confirmation really archives the record"
            )
            await page.get_by_role("link", name="工作台", exact=True).click()
            await expect(page.get_by_label("任务输入")).to_have_value(
                "A newer draft must survive the late receipt"
            )
            await expect(page.locator(".attachment-chips")).to_contain_text("newer.txt")
            passed(
                "background settlement and another session's archive leave the new workbench draft and its file intact"
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
        except Exception:
            api_state = await page.evaluate("""async () => {
                try {
                    let preview = null;
                    try { preview = JSON.parse(sessionStorage.getItem('forge.preview-session.v1') || 'null'); } catch {}
                    const headers = preview?.token ? {'X-Forge-Session': preview.token} : {};
                    const get = async path => (await (await fetch('/api' + path, {headers, signal:AbortSignal.timeout(5000)})).json()).data;
                    const list = await get('/agent/sessions');
                    return await Promise.all(list.items.filter(item => !item.isTest).map(async item => {
                        const detail = await get('/agent/sessions/' + item.id);
                        const events = await get('/agent/sessions/' + item.id + '/trajectory');
                        return {id:item.id, status:detail.status, messageRoles:detail.messages.map(row => row.role),
                            lastUser:detail.messages.filter(row => row.role === 'user').at(-1)?.content,
                            pendingTools:detail.pendingApprovals.map(row => row.tool),
                            lastKinds:events.events.slice(-12).map(row => row.kind)};
                    }));
                } catch(error) { return {diagnosticError:String(error)}; }
            }""")
            await page.screenshot(
                path=str(output.with_name(output.stem + "-failure.png"))
            )
            output.with_name(output.stem + "-failure.json").write_text(
                json.dumps(
                    {
                        "completedChecks": checks,
                        "browserErrors": errors,
                        "url": page.url,
                        "listReads": list_reads,
                        "apiState": api_state,
                        "sessionStates": await page.locator(
                            ".conversation-table-row .session-state"
                        ).all_text_contents(),
                        "pendingApprovalCards": await page.locator(
                            ".approval-card"
                        ).count(),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            raise
        finally:
            await browser.close()
