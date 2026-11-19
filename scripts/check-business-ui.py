#!/usr/bin/env python3
"""企业版第一批 UI 回归：正式 SPA/API，无模型、不替换 API、不伪造资源。

只临时复制/编辑/软删除一个测试场景；凭据不打印，不保存登录密码截图。
执行链路另由 check-business-api.py --browser 的隔离协议夹具验收。
"""

import argparse
import asyncio
import json
from pathlib import Path
import time
from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--base", default="http://127.0.0.1:5173")
parser.add_argument("--credentials", default=str(ROOT / "data/admin-login.txt"))
parser.add_argument("--output", default=str(ROOT / "data/enterprise-checks"))
args = parser.parse_args()
credentials = dict(
    line.split("=", 1) for line in Path(args.credentials).read_text().splitlines()
)
destination = Path(args.output)
destination.mkdir(parents=True, exist_ok=True)
checks = []


def check(name, condition=True):
    assert condition, name
    checks.append(name)
    print("PASS", name, flush=True)


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, args=["--no-sandbox"])
        page = await browser.new_page(viewport={"width": 1440, "height": 1000})
        errors, failed_api, session_posts = [], [], []
        fixture_id = None
        fixture_name = f"企业前端回归-{int(time.time())}"
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on(
            "request",
            lambda request: (
                session_posts.append(request.url)
                if request.method == "POST" and "/api/agent/sessions" in request.url
                else None
            ),
        )

        async def accept_page_leave(dialog):
            if dialog.type != "beforeunload":
                errors.append("Unexpected native dialog: " + dialog.type)
            await dialog.accept()

        page.on("dialog", accept_page_leave)
        page.on(
            "response",
            lambda response: (
                failed_api.append((response.status, response.url))
                if response.status >= 500 and "/api/" in response.url
                else None
            ),
        )

        async def go(path):
            await page.goto(args.base + path)
            await expect(page.locator(".enterprise-shell")).to_be_visible()

        async def screenshot(name):
            await page.screenshot(path=str(destination / name))

        try:
            await page.goto(args.base + "/")
            await expect(page.get_by_role("heading", name="欢迎回来")).to_be_visible()
            await screenshot("login-desktop.png")
            await page.get_by_label("密码", exact=True).fill("invalid-test-password")
            await page.get_by_role("button", name="进入企业平台").click()
            await expect(
                page.get_by_role("alert").filter(has_text="账号或密码不正确")
            ).to_be_visible()
            check("invalid credentials produce a visible error")
            await page.get_by_label("账号", exact=True).fill(credentials["username"])
            await page.get_by_label("密码", exact=True).fill(credentials["password"])
            await page.get_by_role("button", name="进入企业平台").click()
            await expect(page.locator(".workbench-page")).to_be_visible()
            await expect(page.locator(".conversation-scenario-chip")).to_have_count(3)
            await expect(page.locator(".workbench-page h1")).to_have_text(
                "今天要完成什么工作？"
            )
            await expect(page.locator(".workbench-page h1")).to_have_count(1)
            await expect(
                page.locator(
                    ".workbench-section,.workbench-footer,.workbench-scene-card,.workbench-recent-list,.workbench-ability-grid"
                )
            ).to_have_count(0)
            for removed in ["企业公共能力", "继续最近的工作", "全部场景", "全部会话"]:
                await expect(page.locator(".workbench-page")).not_to_contain_text(
                    removed
                )
            await expect(page.locator(".connect-model-prompt")).to_contain_text(
                "模型尚未连接"
            )
            await expect(
                page.get_by_role("button", name="发送任务", exact=True)
            ).to_be_disabled()
            await screenshot("workbench-desktop.png")
            check(
                "root retains the workbench and opens one shared dialogue start with three real non-default scenarios, no directory/recents/promotional modules and honest model state"
            )
            await expect(page.locator(".enterprise-sidebar")).not_to_contain_text(
                "我的工作空间"
            )
            await expect(page.locator(".primary-navigation>a")).to_have_count(4)
            await expect(page.locator(".enterprise-recent-heading")).to_have_text(
                "最近会话"
            )
            await expect(
                page.locator(".enterprise-recent-heading").locator("a,button,svg")
            ).to_have_count(0)
            await expect(
                page.get_by_role("link", name="我的会话", exact=True)
            ).to_have_attribute("href", "/agent/conversations")
            check(
                "shared-resource navigation keeps a plain recent-session label without arrow controls; all conversations remain reachable"
            )
            await expect(page.locator(".enterprise-recent-empty")).to_have_text(
                "开始对话，记录会留在这里。"
            )
            await expect(
                page.locator(
                    ".enterprise-recent-empty br,.enterprise-recent-empty small"
                )
            ).to_have_count(0)
            check("empty recent history is one sentence without stacked helper copy")
            account = page.get_by_role("button", name="账号菜单")
            account_menu = page.get_by_role("menu", name="账号操作", exact=True)
            logout_item = page.get_by_role("menuitem", name="退出登录", exact=True)
            await page.mouse.move(0, 0)
            await expect(account).to_have_attribute("aria-expanded", "false")
            await expect(account_menu).to_have_count(0)
            await expect(page.locator(".enterprise-profile button")).to_have_count(1)
            await expect(page.locator(".enterprise-profile svg")).to_have_count(0)
            check(
                "account footer has one avatar trigger with no permanent exit arrow or logout button"
            )
            await page.locator(".enterprise-avatar").hover()
            await expect(account_menu).to_be_visible()
            await expect(account).to_have_attribute("aria-expanded", "true")
            await logout_item.hover()
            await expect(logout_item).to_be_visible()
            await screenshot("account-hover-desktop.png")
            await page.locator(".workbench-page h1").hover()
            await expect(account_menu).to_have_count(0)
            check(
                "desktop avatar hover exposes a reachable logout menu and leaving dismisses it"
            )
            await page.locator(".enterprise-avatar").hover()
            await expect(account_menu).to_be_visible()
            await account.click()
            await expect(logout_item).to_be_focused()
            await page.locator(".workbench-page h1").hover()
            await expect(account_menu).to_be_visible()
            await account.click()
            await expect(account_menu).to_have_count(0)
            await expect(account).to_be_focused()
            check(
                "clicking a hovered avatar pins its menu; clicking again closes it without logging out"
            )
            await account.click()
            await page.get_by_label("任务输入").click()
            await expect(account_menu).to_have_count(0)
            await expect(page.get_by_label("任务输入")).to_be_focused()
            await account.click()
            await page.get_by_role("link", name="企业场景", exact=True).click()
            await expect(account_menu).to_have_count(0)
            await page.get_by_role("link", name="工作台", exact=True).click()
            await expect(page.locator(".workbench-page")).to_be_visible()
            check(
                "outside clicks keep their target focus and route changes dismiss the account menu"
            )
            for key in ["Enter", "Space", "ArrowDown", "ArrowUp"]:
                await account.focus()
                await page.keyboard.press(key)
                await expect(logout_item).to_be_focused()
                for navigation_key in ["ArrowDown", "ArrowUp", "Home", "End"]:
                    await page.keyboard.press(navigation_key)
                    await expect(logout_item).to_be_focused()
                await page.keyboard.press("Escape")
                await expect(account_menu).to_have_count(0)
                await expect(account).to_be_focused()
            check(
                "avatar keyboard opening, menu arrow keys and Escape restore focus without triggering logout"
            )
            await account.press("Enter")
            await page.keyboard.press("Shift+Tab")
            await expect(account_menu).to_have_count(0)
            await expect(account).to_be_focused()
            await account.press("Enter")
            await page.keyboard.press("Tab")
            await expect(account_menu).to_have_count(0)
            assert await page.evaluate(
                "!document.activeElement.closest('.enterprise-profile')"
            )
            check(
                "account menu supports native Tab and Shift+Tab exit without trapping sidebar focus"
            )
            await page.reload()
            await expect(page.locator(".workbench-page")).to_be_visible()
            check("authenticated session survives SPA reload")
            help_trigger = page.locator(".enterprise-sidebar-footer").get_by_role(
                "button", name="使用帮助", exact=True
            )
            await help_trigger.click()
            await expect(
                page.get_by_role("dialog", name="使用帮助", exact=True)
            ).to_contain_text("提交一项工作")
            await page.keyboard.press("Tab")
            check(
                "sidebar help keyboard focus stays in modal",
                await page.evaluate(
                    "Boolean(document.activeElement.closest('[role=dialog]'))"
                ),
            )
            await page.keyboard.press("Escape")
            await expect(page.get_by_role("dialog")).to_have_count(0)
            await expect(help_trigger).to_be_focused()
            await help_trigger.click()
            await page.get_by_role("link", name="前往平台管理", exact=True).click()
            await expect(page.get_by_role("dialog")).to_have_count(0)
            await expect(page.locator(".release-boundary")).to_contain_text(
                "当前使用单管理员认证，不具备员工间会话访问隔离"
            )
            await go("/agent/workbench")
            check(
                "sidebar help closes with Escape, restores focus, and links to truthful deployment boundaries in management"
            )
            await page.get_by_role("button", name="选择场景").click()
            await (
                page.locator(".scenario-popover>button")
                .filter(has_text="代码与研发")
                .click()
            )
            await expect(page.locator(".scenario-trigger")).to_contain_text(
                "代码与研发"
            )
            await page.get_by_label("任务输入").fill("请分析一个技术问题")
            await page.locator("input[type=file]").set_input_files(
                {
                    "name": "notes.txt",
                    "mimeType": "text/plain",
                    "buffer": b"real attachment content",
                }
            )
            await expect(page.locator(".attachment-chips")).to_contain_text("notes.txt")
            await page.get_by_role("button", name="移除附件 notes.txt").click()
            await expect(page.locator(".attachment-chips")).to_have_count(0)
            check(
                "shared composer selects actual scenario, reads and removes text attachment"
            )
            await page.locator("input[type=file]").set_input_files(
                {
                    "name": "draft.txt",
                    "mimeType": "text/plain",
                    "buffer": b"Preserve the real draft attachment",
                }
            )
            before_selection = len(session_posts)
            await page.get_by_role(
                "button", name="使用场景 文档与报告", exact=True
            ).click()
            await expect(page).to_have_url(args.base + "/agent/workbench")
            await expect(page.get_by_label("任务输入")).to_have_value(
                "请分析一个技术问题"
            )
            await expect(page.get_by_label("任务输入")).to_be_focused()
            await expect(page.locator(".attachment-chips")).to_contain_text("draft.txt")
            await expect(page.locator(".scenario-trigger")).to_contain_text(
                "文档与报告"
            )
            await expect(
                page.get_by_role("button", name="使用场景 文档与报告", exact=True)
            ).to_have_attribute("aria-pressed", "true")
            assert len(session_posts) == before_selection
            check(
                "lightweight scenario selection stays in place, focuses input, preserves text/files and never creates or sends a session"
            )
            await page.get_by_role("link", name="企业场景", exact=True).click()
            await page.get_by_role("link", name="工作台", exact=True).click()
            await expect(page.get_by_label("任务输入")).to_have_value(
                "请分析一个技术问题"
            )
            await expect(page.locator(".attachment-chips")).to_contain_text("draft.txt")
            await expect(page.locator(".scenario-trigger")).to_contain_text(
                "文档与报告"
            )
            check(
                "returning to the workbench restores its task draft, selected scenario and actual attachment without a reset"
            )
            page.remove_listener("dialog", accept_page_leave)
            try:
                async with page.expect_event("dialog") as captured_leave:
                    await page.evaluate("setTimeout(() => location.reload(), 0)")
                leave = await captured_leave.value
                assert leave.type == "beforeunload"
                await leave.dismiss()
            finally:
                page.on("dialog", accept_page_leave)
            await expect(page.get_by_label("任务输入")).to_have_value(
                "请分析一个技术问题"
            )
            await expect(page.locator(".attachment-chips")).to_contain_text("draft.txt")
            assert await page.evaluate(
                "!JSON.stringify({...localStorage, ...sessionStorage}).includes('请分析一个技术问题')"
            )
            check(
                "browser refresh warns before discarding a tab-memory draft; cancel keeps its text/file and raw business content is not persisted to storage"
            )
            await page.locator(".enterprise-new-chat").click()
            confirmation = page.get_by_role("dialog", name="新建会话确认", exact=True)
            await expect(confirmation).to_be_visible()
            await expect(page.locator("#app")).to_have_attribute("aria-hidden", "true")
            assert await page.locator("#app").evaluate("element => element.inert")
            for key in ["Tab"] * 8 + ["Shift+Tab"] * 8:
                await page.keyboard.press(key)
                assert await confirmation.evaluate(
                    "element => element.contains(document.activeElement)"
                )
            await page.keyboard.press("Escape")
            await expect(confirmation).to_have_count(0)
            await expect(page.locator("#app")).not_to_have_attribute(
                "aria-hidden", "true"
            )
            assert not await page.locator("#app").evaluate("element => element.inert")
            await expect(page.locator(".enterprise-new-chat")).to_be_focused()
            await expect(page.get_by_label("任务输入")).to_have_value(
                "请分析一个技术问题"
            )
            await expect(page.locator(".attachment-chips")).to_contain_text("draft.txt")
            check(
                "new-chat draft replacement asks explicitly, traps keyboard focus and preserves the draft on Escape"
            )
            await page.get_by_role("link", name="企业场景", exact=True).click()
            await page.locator(".enterprise-new-chat").click()
            await confirmation.get_by_role(
                "button", name="返回草稿", exact=True
            ).click()
            await expect(page).to_have_url(args.base + "/agent/workbench")
            await expect(page.get_by_label("任务输入")).to_have_value(
                "请分析一个技术问题"
            )
            await expect(page.locator(".attachment-chips")).to_contain_text("draft.txt")
            await page.locator(".enterprise-new-chat").click()
            await confirmation.get_by_role(
                "button", name="放弃草稿并新建", exact=True
            ).click()
            await expect(page).to_have_url(args.base + "/agent/chat")
            await expect(page.locator(".conversation-start-surface")).to_have_count(1)
            await expect(page.locator("h1")).to_have_text("今天要完成什么工作？")
            await expect(page.locator(".enterprise-composer-area")).to_have_count(0)
            await expect(page.get_by_label("任务输入")).to_have_value("")
            await expect(page.locator(".attachment-chips")).to_have_count(0)
            assert len(session_posts) == before_selection
            check(
                "return-to-draft and explicit discard are distinct; new chat reuses the same start UI without creating a session or a duplicate bottom composer"
            )
            await page.get_by_label("任务输入").fill("请分析一个技术问题")
            await page.get_by_role("button", name="发送任务", exact=True).click()
            await expect(page).to_have_url(args.base + "/agent/models")
            await expect(
                page.get_by_role("heading", name="模型连接", exact=True)
            ).to_be_visible()
            await expect(
                page.get_by_role("button", name="测试已保存的连接")
            ).to_be_disabled()
            check("unconfigured model goes to real setup; never fabricates execution")
            await page.get_by_role("button", name="DeepSeek", exact=True).click()
            await expect(page.get_by_label("Base URL")).to_have_value(
                "https://api.deepseek.com"
            )
            await page.get_by_role("link", name="企业场景", exact=True).click()
            await page.get_by_role("link", name="平台管理", exact=True).click()
            await (
                page.locator(".enterprise-admin-tabs")
                .get_by_role("link", name="模型连接", exact=True)
                .click()
            )
            await expect(page.get_by_label("Base URL")).to_have_value("")
            check("model preset stays an unsaved draft until explicit save")
            await screenshot("models-desktop.png")
            await page.get_by_role("link", name="企业场景", exact=True).click()
            await expect(page.locator(".scenario-card")).to_have_count(4)
            await expect(
                page.get_by_role("button", name="新建场景", exact=True)
            ).to_have_count(0)
            await (
                page.locator(".scenario-card")
                .first.get_by_role("button", name="详情")
                .click()
            )
            await expect(page.get_by_role("dialog", name="场景详情")).to_contain_text(
                "用途"
            )
            await expect(page.get_by_role("dialog", name="场景详情")).not_to_contain_text(
                "工作规范"
            )
            await page.keyboard.press("Escape")
            await screenshot("scenarios-desktop.png")
            check(
                "scenario catalogue separates use from maintenance and exposes real details"
            )
            await page.get_by_role("button", name="维护场景", exact=True).click()
            await (
                page.locator(".scenario-card")
                .first.get_by_role("button", name="详情")
                .click()
            )
            await expect(page.get_by_role("dialog", name="场景详情")).to_contain_text(
                "工作规范"
            )
            await expect(page.get_by_role("dialog", name="场景详情")).to_contain_text(
                "版本信息"
            )
            await page.keyboard.press("Escape")
            async with page.expect_response(
                lambda response: (
                    response.url.endswith("/copy") and response.request.method == "POST"
                )
            ) as response:
                await (
                    page.locator(".scenario-card")
                    .first.get_by_role("button", name="复制为草稿")
                    .click()
                )
            fixture_id = (await (await response.value).json())["data"]["id"]
            await expect(page.locator(".scenario-card")).to_have_count(1)
            card = page.locator(".scenario-card").first
            await card.get_by_role("button", name="编辑", exact=True).click()
            await page.get_by_label("场景名称").fill(fixture_name)
            await page.get_by_label("一句话介绍").fill(
                "只用于真实界面 CRUD 回归，验收后删除。"
            )
            await page.get_by_label("角色、目标与工作方式").fill(
                "这是企业前端回归提示词，不是已执行的模型任务。"
            )
            await page.get_by_role("button", name="保存草稿", exact=True).click()
            await expect(page.get_by_role("dialog", name="场景编辑器")).to_have_count(0)
            await expect(card.get_by_role("heading")).to_have_text(fixture_name)
            await card.get_by_role("button", name="版本 v2").click()
            await expect(page.locator(".version-entry")).to_have_count(2)
            await page.locator(".version-entry").first.locator("summary").click()
            await expect(
                page.locator(".version-entry").first.locator("pre")
            ).to_contain_text("企业前端回归提示词")
            await page.keyboard.press("Escape")
            check(
                "template copy, maintenance edit and immutable version history persist"
            )
            await page.get_by_role("button", name="返回使用目录").click()
            await expect(page.locator(".scenario-card")).to_have_count(4)
            await expect(page.locator(".scenario-grid")).not_to_contain_text(
                fixture_name
            )
            check(
                "maintenance drafts do not masquerade as published enterprise scenarios"
            )
            await page.get_by_role("button", name="维护场景", exact=True).click()
            await page.get_by_label("搜索场景").fill(fixture_name)
            await page.get_by_role("button", name="预览草稿", exact=True).click()
            await expect(
                page.get_by_role("dialog", name="新建会话确认", exact=True)
            ).to_be_visible()
            await page.get_by_role("button", name="放弃草稿并新建", exact=True).click()
            await expect(page.locator(".start-draft-notice")).to_contain_text(
                "维护草稿预览"
            )
            await expect(page.locator(".scenario-trigger")).to_contain_text(
                fixture_name
            )
            await expect(page.locator(".context-panel")).to_have_count(0)
            await page.get_by_role("button", name="查看结果", exact=True).click()
            await expect(page.locator(".context-panel")).to_be_visible()
            await expect(page.locator(".panel-empty")).to_contain_text("结果会留在这里")
            await page.get_by_role("button", name="关闭会话详情").click()
            await page.get_by_role("button", name="查看过程", exact=True).click()
            await expect(page.locator(".panel-empty")).to_contain_text(
                "过程会在执行时出现"
            )
            await page.keyboard.press("Escape")
            await expect(page.locator(".context-panel")).to_have_count(0)
            check(
                "conversation detail is on-demand; empty results/process never claim success"
            )
            await page.get_by_role("link", name="企业场景", exact=True).click()
            await page.get_by_role("button", name="维护场景", exact=True).click()
            await page.get_by_label("搜索场景").fill(fixture_name)
            await page.get_by_role(
                "button", name=f"删除场景 {fixture_name}", exact=True
            ).click()
            await expect(
                page.get_by_role("dialog", name="删除场景确认")
            ).to_be_visible()
            await page.get_by_role("button", name="确认删除", exact=True).click()
            await expect(
                page.get_by_role("heading", name="没有找到匹配的场景")
            ).to_be_visible()
            fixture_id = None
            check("confirmed soft delete works and leaves a real search empty state")
            await page.get_by_role("link", name="能力管理", exact=True).click()
            await expect(
                page.get_by_role("heading", name="能力管理", exact=True)
            ).to_be_visible()
            await expect(page.locator(".enterprise-tool-card")).to_have_count(4)
            await expect(page.locator(".plugin-card")).to_have_count(0)
            await page.get_by_label("搜索能力").fill("nonexistent-tool")
            await expect(
                page.get_by_role("heading", name="没有匹配的能力")
            ).to_be_visible()
            await page.get_by_role("button", name="清除搜索").click()
            await page.get_by_role("button", name="查看生成文本产物详情").click()
            await expect(page.get_by_role("dialog", name="工具详情")).to_contain_text(
                "默认需要确认"
            )
            await expect(page.locator(".related-scenario").first).to_be_visible()
            await page.keyboard.press("Escape")
            check(
                "public tools support discovery, search, readable boundaries and related scenarios"
            )
            await screenshot("capabilities-desktop.png")
            await page.locator(".runtime-details>summary").click()
            await expect(page.locator(".runtime-component-list>article")).to_have_count(
                2
            )
            await page.get_by_role("button", name="组件详情", exact=True).first.click()
            await expect(page.get_by_role("dialog", name="组件详情")).to_be_visible()
            await page.keyboard.press("Escape")
            check(
                "SDK/runtime components are advanced information, not fake installable business plugins"
            )
            await page.locator(".collection-tabs > button").filter(has_text="技能").click()
            await expect(page.locator(".enterprise-empty")).to_contain_text("还没有技能")
            await expect(
                page.locator(".enterprise-empty").get_by_role("link", name="新建技能")
            ).to_be_visible()
            await page.locator(".collection-tabs > button").filter(has_text="MCP 服务").click()
            await expect(page.locator(".enterprise-empty")).to_contain_text("还没有 MCP 服务")
            await expect(
                page.locator(".enterprise-empty").get_by_role("button", name="添加 MCP 服务")
            ).to_be_visible()
            await page.reload()
            await expect(page.locator(".enterprise-empty")).to_contain_text("还没有 MCP 服务")
            await screenshot("mcp-desktop.png")
            check("Skill/MCP tabs have concise empty states and one clear next action")
            await go("/agent/conversations")
            await expect(
                page.get_by_role("heading", name="我的会话", exact=True)
            ).to_be_visible()
            await expect(page.locator(".preview-inline-note")).to_contain_text(
                "隔离尚未接入"
            )
            await page.get_by_label("搜索会话").fill("nothing")
            await expect(
                page.get_by_role("heading", name="没有匹配的会话")
            ).to_be_visible()
            await page.get_by_role("button", name="清除筛选").click()
            await expect(page.locator(".conversation-table-row")).to_have_count(0)
            check(
                "conversation centre uses real empty data and honestly discloses isolation boundary"
            )
            await go("/agent/chat/not-a-valid-id")
            await expect(page.locator(".session-load-error")).to_contain_text(
                "会话地址无效"
            )
            await expect(page.locator(".task-composer")).to_have_count(0)
            await go("/agent/chat/99999999")
            await expect(page.locator(".session-load-error")).to_be_visible()
            check(
                "invalid and missing session deep links show recoverable errors, not a misleading new chat"
            )
            await go("/agent/manage")
            await (
                page.locator(".enterprise-admin-tabs")
                .get_by_role("link", name="企业策略", exact=True)
                .click()
            )
            await expect(
                page.get_by_role("switch", name="写入前需要审批")
            ).to_have_attribute("aria-checked", "true")
            await page.get_by_role("button", name="保存策略").click()
            await expect(page.get_by_role("alert")).to_contain_text("策略已保存")
            check("existing CSRF-protected governance still persists actual policy")
            await (
                page.locator(".enterprise-admin-tabs")
                .get_by_role("link", name="运行审计", exact=True)
                .click()
            )
            await expect(
                page.get_by_role("heading", name="真实工作，从第一项任务开始")
            ).to_be_visible()
            check("audit remains real and contains no invented model executions")
            routes = [
                ("workbench", "workbench"),
                ("scenarios", "scenarios"),
                ("capabilities", "capabilities"),
                ("chat", "chat"),
                ("conversations", "conversations"),
                ("manage", "management"),
                ("models", "models"),
                ("governance", "governance"),
                ("audit", "audit"),
            ]
            for width in [390, 768]:
                await page.set_viewport_size(
                    {"width": width, "height": 844 if width == 390 else 1024}
                )
                for path, name in routes:
                    await go("/agent/" + path)
                    await page.wait_for_timeout(80)
                    overflow = await page.evaluate(
                        'document.documentElement.scrollWidth > innerWidth || document.querySelector(".enterprise-body").scrollWidth > document.querySelector(".enterprise-body").clientWidth'
                    )
                    check(
                        f"{name}: {width}px viewport has no horizontal overflow",
                        not overflow,
                    )
                    if width == 390:
                        await screenshot(f"{name}-mobile.png")
            navigation_layouts = []
            for width, height in [
                (1440, 1000),
                (1024, 900),
                (900, 1024),
                (820, 1000),
                (768, 1024),
                (701, 900),
                (700, 844),
                (390, 844),
                (320, 720),
                (820, 480),
            ]:
                await page.set_viewport_size({"width": width, "height": height})
                await go("/agent/workbench")
                await expect(page.locator(".enterprise-primary > a")).to_have_count(4)
                geometry = await page.evaluate(
                    r"""() => {
                    const box = element => {
                        const r = element.getBoundingClientRect();
                        return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};
                    };
                    const sidebar = document.querySelector('.enterprise-sidebar');
                    return {
                        sidebar: box(sidebar), inert: sidebar.inert,
                        body: box(document.querySelector('.enterprise-body')),
                        items: [...document.querySelectorAll('.enterprise-new-chat,.enterprise-primary>a,.enterprise-management-link')].map(element => ({
                            row:box(element), icon:box(element.querySelector('svg')),
                            fontSize:getComputedStyle(element).fontSize,
                            fontWeight:Number(getComputedStyle(element).fontWeight),
                            svgIcon:element.querySelector('svg')?.getAttribute('fill') === 'none',
                            emojiIcon:/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u20E3]/u.test(element.innerText),
                            label:box(element.querySelector('span:not(.nav-count)')),
                            labelHidden: getComputedStyle(element.querySelector('span:not(.nav-count)')).display === 'none',
                            labelClipped: element.querySelector('span:not(.nav-count)').scrollWidth > element.querySelector('span:not(.nav-count)').clientWidth + 1,
                        })),
                        accent:getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
                    };
                }"""
                )
                assert not geometry["inert"], (width, height, geometry)
                assert abs(geometry["sidebar"]["x"]) < 1, (width, height, geometry)
                assert abs(geometry["body"]["x"] - geometry["sidebar"]["right"]) < 1
                assert abs(geometry["body"]["right"] - width) < 1
                assert geometry["accent"] == "#da724d"
                assert not any(
                    item["labelHidden"] or item["labelClipped"]
                    for item in geometry["items"]
                )
                items = geometry["items"]
                assert all(item["fontWeight"] >= 600 for item in items)
                assert all(
                    item["fontSize"] == ("14px" if width > 700 else "11px")
                    for item in items
                )
                assert all(item["svgIcon"] and not item["emojiIcon"] for item in items)
                await expect(
                    page.locator(".enterprise-primary > a.is-active")
                ).to_have_css("font-weight", "700")
                icon_centres = [
                    item["icon"]["x"] + item["icon"]["width"] / 2 for item in items
                ]
                assert max(icon_centres) - min(icon_centres) < 1, (
                    width,
                    height,
                    geometry,
                )
                if width > 700:
                    text_starts = [item["label"]["x"] for item in items]
                    assert max(text_starts) - min(text_starts) < 1, (
                        width,
                        height,
                        geometry,
                    )
                    assert all(item["row"]["height"] == 44 for item in items)
                else:
                    text_centres = [
                        item["label"]["x"] + item["label"]["width"] / 2
                        for item in items
                    ]
                    assert max(text_centres) - min(text_centres) < 1, (
                        width,
                        height,
                        geometry,
                    )
                    assert all(item["row"]["height"] == 66 for item in items)
                navigation_layouts.append(
                    {"width": width, "height": height, **geometry}
                )
                if (width, height) in [(820, 1000), (390, 844), (820, 480)]:
                    await screenshot(f"navigation-{width}x{height}.png")
            (destination / "navigation-layout.json").write_text(
                json.dumps(navigation_layouts, ensure_ascii=False, indent=2)
            )
            check(
                "navigation stays visible without an overlay or content overlap at ten desktop/tablet/phone/short-window sizes"
            )
            check(
                "new chat, primary menus and platform management share aligned icon/text columns and row heights; labels and original warm-orange theme remain intact"
            )
            check(
                "sidebar primary labels use readable semibold sizing and a stronger selected state across desktop and phone layouts"
            )
            check(
                "navigation icons remain local line SVGs with no decorative emoji text"
            )
            await page.set_viewport_size({"width": 820, "height": 480})
            last_menu = page.get_by_role("link", name="我的会话", exact=True)
            await last_menu.focus()
            await expect(last_menu).to_be_in_viewport()
            await page.get_by_role("link", name="平台管理", exact=True).focus()
            await expect(
                page.get_by_role("link", name="平台管理", exact=True)
            ).to_be_in_viewport()
            check(
                "short-window navigation scrolls independently without covering the fixed account and management footer"
            )
            await page.set_viewport_size({"width": 390, "height": 844})
            await page.get_by_role("link", name="工作台", exact=True).focus()
            reached_content = False
            for _ in range(20):
                await page.keyboard.press("Tab")
                if await page.evaluate(
                    "Boolean(document.activeElement.closest('.enterprise-body'))"
                ):
                    reached_content = True
                    break
            assert reached_content, "persistent navigation must not trap keyboard focus"
            await page.keyboard.press("Escape")
            await page.get_by_role("link", name="企业场景", exact=True).click()
            await expect(
                page.locator(".enterprise-primary > a.is-active")
            ).to_have_attribute("aria-label", "企业场景")
            await expect(page.locator(".enterprise-sidebar")).to_be_visible()
            await expect(
                page.get_by_role("button", name="打开导航", exact=True)
            ).to_have_count(0)
            check(
                "persistent phone navigation remains visible after Escape and route changes; keyboard focus reaches content without a drawer trap"
            )
            await expect(page.locator(".enterprise-avatar")).to_be_visible()
            await expect(
                page.get_by_role("menuitem", name="退出登录", exact=True)
            ).to_have_count(0)
            await page.get_by_role("button", name="账号菜单").click()
            await page.get_by_role("menuitem", name="退出登录", exact=True).click()
            await expect(page.get_by_role("heading", name="欢迎回来")).to_be_visible()
            check("mobile avatar menu logout is reachable and clears authentication")
            await page.get_by_label("账号", exact=True).fill(credentials["username"])
            await page.get_by_label("密码", exact=True).fill(credentials["password"])
            await page.get_by_role("button", name="进入企业平台").click()
            await page.get_by_role("link", name="工作台", exact=True).click()
            await page.get_by_label("任务输入").fill("Must be purged on logout")
            await page.locator("input[type=file]").set_input_files(
                {
                    "name": "private.txt",
                    "mimeType": "text/plain",
                    "buffer": b"Do not persist business text",
                }
            )
            await expect(page.locator(".enterprise-avatar")).to_be_visible()
            await expect(
                page.get_by_role("menuitem", name="退出登录", exact=True)
            ).to_have_count(0)
            await page.get_by_role("button", name="账号菜单").click()
            await page.get_by_role("menuitem", name="退出登录", exact=True).click()
            await expect(page.get_by_role("heading", name="欢迎回来")).to_be_visible()
            await page.get_by_label("账号", exact=True).fill(credentials["username"])
            await page.get_by_label("密码", exact=True).fill(credentials["password"])
            await page.get_by_role("button", name="进入企业平台").click()
            await expect(page.get_by_label("任务输入")).to_have_value("")
            await expect(page.locator(".attachment-chips")).to_have_count(0)
            assert await page.evaluate(
                "!JSON.stringify({...localStorage, ...sessionStorage}).includes('Must be purged on logout')"
            )
            check(
                "logout and re-login purge tab-local business drafts and attachments; raw task text never enters browser storage"
            )
            check(
                "no browser JavaScript exceptions or API 5xx",
                not errors and not failed_api,
            )
            report = {
                "result": "passed",
                "scope": "actual single-admin deployment, no model, no API mocks; not multi-user acceptance",
                "checks": len(checks),
                "items": checks,
                "errors": errors,
                "serverErrors": failed_api,
            }
            (destination / "ui-report.json").write_text(
                json.dumps(report, ensure_ascii=False, indent=2)
            )
            print(
                json.dumps(
                    {"checks": len(checks), "result": "passed"}, ensure_ascii=False
                )
            )
        except Exception:
            if await page.locator("#password").count():
                await page.locator("#password").fill("")
            await screenshot("ui-failure.png")
            print("JS errors:", errors, "API server errors:", failed_api)
            raise
        finally:
            if fixture_id:
                # Only remove this test's exact copied resource, including on assertion failure.
                await page.evaluate(
                    """async (id) => {
                    let preview = null; try { preview = JSON.parse(sessionStorage.getItem('forge.preview-session.v1') || 'null'); } catch {}
                    const headers = preview?.token ? {'X-Forge-Session': preview.token} : {};
                    const auth = (await (await fetch('/api/auth/session', {headers})).json()).data;
                    if (auth.authenticated) await fetch('/api/agent-scenarios/' + id, {method:'DELETE', headers:{...headers,'X-Forge-CSRF':auth.csrfToken}});
                }""",
                    fixture_id,
                )
            await browser.close()


asyncio.run(main())
