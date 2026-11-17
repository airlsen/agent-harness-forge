#!/usr/bin/env python3
"""真实业务 UI 冒烟：无模型配置时不伪造对话；只临时创建/删除一个场景。

需 Playwright Chromium。凭据从受保护文件读取，不打印、不截图密码。
"""

import argparse
import asyncio
import json
from pathlib import Path
import re
from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--base", default="http://127.0.0.1:5173")
parser.add_argument("--credentials", default=str(ROOT / "data/admin-login.txt"))
parser.add_argument("--output", default=str(ROOT / "data/business-checks"))
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
    print("PASS", name)


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, args=["--no-sandbox"])
        page = await browser.new_page(
            viewport={"width": 1440, "height": 1000}, device_scale_factor=1
        )
        errors, failed_api = [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on(
            "response",
            lambda response: (
                failed_api.append((response.status, response.url))
                if response.status >= 500 and "/api/" in response.url
                else None
            ),
        )
        try:
            await page.goto(args.base + "/agent/chat")
            await expect(page.get_by_role("heading", name="欢迎回来")).to_be_visible()
            await page.screenshot(path=str(destination / "login-desktop.png"))
            check("built SPA deep link serves login, not Vite/POC")
            await page.get_by_label("密码", exact=True).fill("invalid-test-password")
            await page.get_by_role("button", name="进入工作空间").click()
            await expect(
                page.get_by_role("alert").filter(has_text="账号或密码不正确")
            ).to_be_visible()
            check("invalid credentials produce a visible error")
            await page.get_by_label("账号", exact=True).fill(credentials["username"])
            await page.get_by_label("密码", exact=True).fill(credentials["password"])
            await page.get_by_role("button", name="进入工作空间").click()
            await page.wait_for_selector(".app-shell")
            await expect(page.locator(".connect-model-prompt")).to_contain_text(
                "模型未配置"
            )
            await expect(page.locator(".primary-navigation .nav-count")).to_have_text(
                "4"
            )
            await page.screenshot(path=str(destination / "chat-desktop.png"))
            check("login opens real routed workbench with four scenarios")
            await page.reload()
            await expect(page.locator(".app-shell")).to_be_visible()
            check("HttpOnly authenticated session survives SPA reload")
            await page.get_by_role("button", name="一起解决一个技术问题").click()
            await expect(page.locator(".scenario-trigger")).to_contain_text(
                "代码与研发"
            )
            await expect(page.get_by_label("任务输入")).to_have_value(
                re.compile("技术问题")
            )
            check("task suggestion actually selects scenario and fills composer")
            await page.get_by_role("button", name="发送任务", exact=True).click()
            await expect(page).to_have_url(args.base + "/agent/models")
            await expect(page.locator(".page-heading .tag")).to_contain_text(
                "模型未配置"
            )
            await expect(
                page.get_by_role("button", name="测试已保存的连接")
            ).to_be_disabled()
            check("unconfigured model directs user to setup, never fabricates success")
            await page.get_by_role("button", name="DeepSeek", exact=True).click()
            await expect(page.get_by_label("Base URL")).to_have_value(
                "https://api.deepseek.com"
            )
            await expect(page.get_by_label("模型 ID")).to_have_value("deepseek-chat")
            await page.get_by_role("link", name="场景中心", exact=True).click()
            await page.get_by_role("link", name="模型中心", exact=True).click()
            await expect(page.get_by_label("Base URL")).to_have_value("")
            check("model preset is editable draft only until explicitly saved")
            await page.screenshot(path=str(destination / "models-desktop.png"))
            await page.get_by_role("link", name="场景中心", exact=True).click()
            await expect(page.locator(".scenario-card")).to_have_count(4)
            await page.screenshot(path=str(destination / "scenarios-desktop.png"))
            await (
                page.locator(".scenario-card")
                .first.get_by_role("button", name="复制", exact=True)
                .click()
            )
            await expect(page.locator(".scenario-card")).to_have_count(1)
            card = page.locator(".scenario-card").first
            await card.get_by_role("button", name="编辑", exact=True).click()
            await expect(page.get_by_role("dialog", name="场景编辑器")).to_be_visible()
            await page.get_by_label("场景名称").fill("浏览器回归验证场景")
            await page.get_by_label("一句话介绍").fill(
                "只用于界面 CRUD 回归，验收后删除。"
            )
            await page.get_by_label("角色、目标与工作方式").fill(
                "这是一条 UI 回归验证提示词，不是已执行的模型任务。"
            )
            await page.get_by_role("button", name="保存草稿", exact=True).click()
            await expect(
                page.get_by_role("dialog", name="场景编辑器")
            ).not_to_be_visible()
            await expect(card.get_by_role("heading")).to_have_text("浏览器回归验证场景")
            await expect(card.get_by_role("button", name="版本 v2")).to_be_visible()
            check("official-template copy and drawer edit persist a second version")
            await card.get_by_role("button", name="版本 v2").click()
            await expect(page.locator(".version-entry")).to_have_count(2)
            await page.locator(".version-entry").first.locator("summary").click()
            await expect(
                page.locator(".version-entry").first.locator("pre")
            ).to_contain_text("UI 回归验证提示词")
            await page.get_by_role("button", name="关闭版本历史").click()
            check("version drawer displays immutable recorded payloads")
            await card.get_by_role("button", name="使用场景").click()
            await expect(page.locator(".scenario-trigger")).to_contain_text(
                "浏览器回归验证场景"
            )
            check("use-scenario action connects management page to chat workbench")
            await page.get_by_role("link", name="场景中心", exact=True).click()
            await page.get_by_label("搜索场景").fill("浏览器回归验证场景")
            await page.get_by_role(
                "button", name="删除场景 浏览器回归验证场景", exact=True
            ).click()
            await expect(
                page.get_by_role("dialog", name="删除场景确认")
            ).to_be_visible()
            await page.get_by_role("button", name="确认删除", exact=True).click()
            await expect(
                page.get_by_role("heading", name="没有找到匹配的场景")
            ).to_be_visible()
            check("delete confirmation and search empty state both work")
            await page.get_by_role("link", name="能力中心", exact=True).click()
            await expect(page.locator(".plugin-card")).to_have_count(2)
            await page.screenshot(path=str(destination / "capabilities-desktop.png"))
            await page.get_by_role("button", name="组件详情").first.click()
            await expect(page.get_by_role("dialog", name="组件详情")).to_be_visible()
            await page.get_by_role("button", name="关闭组件详情").click()
            await page.get_by_role("button", name=re.compile("内置工具")).click()
            await expect(page.locator(".tools-list>article")).to_have_count(4)
            await page.get_by_role("button", name=re.compile("Skill 库")).click()
            await expect(page.locator(".capability-unavailable")).to_contain_text(
                "尚未接入"
            )
            await page.get_by_role("button", name=re.compile("MCP 服务")).click()
            await expect(page.locator(".capability-unavailable")).to_contain_text(
                "没有已连接的 MCP"
            )
            check(
                "capability directory is functional and labels Skill/MCP as unavailable"
            )
            await page.get_by_role("link", name="治理与设置", exact=True).click()
            await expect(
                page.get_by_role("switch", name="写入前需要审批")
            ).to_have_attribute("aria-checked", "true")
            await expect(page.locator(".policy-tool-list input:checked")).to_have_count(
                4
            )
            await page.screenshot(path=str(destination / "governance-desktop.png"))
            await page.get_by_role("button", name="保存策略").click()
            await expect(page.get_by_role("alert")).to_contain_text("策略已保存")
            check("real governance policy loads and can be persisted with CSRF")
            await page.get_by_role("link", name="审计中心", exact=True).click()
            await expect(
                page.get_by_role("heading", name="真实工作，从第一项任务开始")
            ).to_be_visible()
            await page.screenshot(path=str(destination / "audit-desktop.png"))
            check("no model tasks means no invented audit activity")
            for path, name in [
                ("/agent/chat", "chat"),
                ("/agent/scenarios", "scenarios"),
                ("/agent/models", "models"),
                ("/agent/governance", "governance"),
                ("/agent/capabilities", "capabilities"),
                ("/agent/audit", "audit"),
            ]:
                await page.set_viewport_size({"width": 390, "height": 844})
                await page.goto(args.base + path)
                await page.wait_for_selector(".app-shell")
                await page.wait_for_timeout(180)
                await page.screenshot(path=str(destination / f"{name}-mobile.png"))
                overflow = await page.evaluate(
                    'document.documentElement.scrollWidth > innerWidth || document.querySelector(".app-body").scrollWidth > document.querySelector(".app-body").clientWidth'
                )
                check(f"{name}: 390px layout has no horizontal overflow", not overflow)
            await page.get_by_role("button", name="退出登录", exact=True).click()
            await expect(page.get_by_role("heading", name="欢迎回来")).to_be_visible()
            check("mobile logout remains reachable and clears partitioned session")
            check("no browser JS exceptions or API 5xx", not errors and not failed_api)
            print(
                json.dumps(
                    {"checks": len(checks), "result": "passed"}, ensure_ascii=False
                )
            )
            (destination / "ui-report.json").write_text(
                json.dumps(
                    {
                        "checks": len(checks),
                        "result": "passed",
                        "items": checks,
                        "errors": errors,
                        "serverErrors": failed_api,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
        except Exception:
            # 若还在登录页，永不将真实密码保存为截图。
            if await page.locator("#password").count():
                await page.locator("#password").fill("")
            await page.screenshot(path=str(destination / "ui-failure.png"))
            print("JS errors:", errors, "API server errors:", failed_api)
            raise
        finally:
            await browser.close()


asyncio.run(main())
