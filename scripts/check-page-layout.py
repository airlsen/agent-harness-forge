#!/usr/bin/env python3
"""正式部署的页面布局回归：只读取业务资源，不创建会话或更改模型配置。

可选 --axe-script /path/to/axe.min.js 执行 WCAG 2 A/AA 自动化检查。
加载条检查只暂停真实 GET 的发送，不替换任何 API 响应。
"""

import argparse
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path

from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
SIZES = [
    (1920, 1080),
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
]
ROUTES = [
    "workbench",
    "scenarios",
    "capabilities",
    "conversations",
    "manage",
    "models",
    "governance",
    "audit",
]
AUDIT_SIZES = {(1440, 1000), (820, 1000), (390, 844)}


def options():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:5173")
    parser.add_argument("--credentials", default=str(ROOT / "data/admin-login.txt"))
    parser.add_argument("--output", default=str(ROOT / "data/layout-checks"))
    parser.add_argument("--axe-script", type=Path)
    return parser.parse_args()


async def main(args):
    credentials = dict(
        line.split("=", 1) for line in Path(args.credentials).read_text().splitlines()
    )
    destination = Path(args.output)
    destination.mkdir(parents=True, exist_ok=True)
    if args.axe_script and not args.axe_script.is_file():
        raise FileNotFoundError(args.axe_script)
    checks, layouts, states, fonts, errors, server_errors = [], [], [], [], [], []

    def passed(name):
        checks.append(name)
        print("PASS layout:", name, flush=True)

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(args=["--no-sandbox"])
        page = await browser.new_page(viewport={"width": 1440, "height": 1000})
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on(
            "response",
            lambda response: (
                server_errors.append({"status": response.status, "url": response.url})
                if response.status >= 500 and "/api/" in response.url
                else None
            ),
        )

        async def go(route):
            await page.goto(args.base + "/agent/" + route)
            await expect(
                page.locator(".enterprise-view main,.enterprise-view>.enterprise-chat")
            ).to_have_count(1)
            await expect(page.locator(".global-progress")).to_have_count(0)
            await page.wait_for_function("document.fonts.status === 'loaded'")

        async def screenshot(name):
            await page.mouse.move(0, 0)
            await page.screenshot(path=str(destination / (name + ".png")))

        async def audit(name):
            if not args.axe_script:
                return
            # Let real page-local fetches and disabled-button transitions settle.
            await page.wait_for_load_state("networkidle")
            await page.add_script_tag(path=str(args.axe_script))
            result = await page.evaluate(
                """async () => {
                    const result = await axe.run(document, {
                        runOnly: {type: 'tag', values: ['wcag2a', 'wcag2aa']},
                    });
                    return result.violations.map(item => ({
                        id: item.id,
                        nodes: item.nodes.map(node => ({
                            target: node.target, failureSummary: node.failureSummary,
                        })),
                    }));
                }"""
            )
            states.append({"state": name, "violations": result})
            print("A11Y:", name, len(result), "violations", flush=True)

        try:
            await page.goto(args.base + "/")
            await expect(page.locator(".login-footnote")).to_contain_text(
                "单管理员业务预览，尚未接入员工身份与会话权限"
            )
            await audit("login")
            await page.get_by_label("账号", exact=True).fill(credentials["username"])
            await page.get_by_label("密码", exact=True).fill(credentials["password"])
            await page.get_by_role("button", name="进入企业平台").click()
            await expect(page.locator(".workbench-page")).to_be_visible()
            passed("login keeps the actual single-admin deployment disclosure")

            # Hold, then send the real GET so the loading indicator can be measured.
            release = asyncio.Event()

            async def hold_real_request(route):
                await release.wait()
                await route.continue_()

            pattern = "**/api/agent-scenarios"
            await page.route(pattern, hold_real_request)
            try:
                await page.reload(wait_until="domcontentloaded")
                progress = page.locator(".global-progress")
                await expect(progress).to_be_visible()
                bounds = await progress.bounding_box()
                assert bounds and abs(bounds["y"]) < 1, bounds
                await expect(progress).to_have_css("pointer-events", "none")
            finally:
                release.set()
                await page.unroute_all(behavior="wait")
            await expect(page.locator(".global-progress")).to_have_count(0)
            passed(
                "real initialization progress starts at y=0 with no retired header offset"
            )

            # Preset actions must not be overwritten by a late configuration read.
            await go("manage")
            model_release = asyncio.Event()

            async def hold_model_request(route):
                await model_release.wait()
                await route.continue_()

            await page.route("**/api/models/connection", hold_model_request)
            try:
                await (
                    page.locator(".enterprise-admin-tabs")
                    .get_by_role("link", name="模型连接", exact=True)
                    .click()
                )
                presets = page.locator(".provider-presets>button")
                await expect(presets).to_have_count(3)
                for button in await presets.all():
                    await expect(button).to_be_disabled()
                await expect(page.locator("#model-form")).to_have_count(0)
            finally:
                model_release.set()
                await page.unroute_all(behavior="wait")
            await expect(page.locator("#model-form")).to_be_visible()
            saved_url = await page.get_by_label("Base URL").input_value()
            await page.get_by_role("button", name="DeepSeek", exact=True).click()
            await expect(page.get_by_label("Base URL")).to_have_value(
                "https://api.deepseek.com"
            )
            await go("models")
            await expect(page.get_by_label("Base URL")).to_have_value(saved_url)
            passed(
                "model presets wait for the real configuration read and remain unsaved drafts"
            )

            for width, height in SIZES:
                await page.set_viewport_size({"width": width, "height": height})
                for route in ROUTES:
                    await go(route)
                    geometry = await page.evaluate(
                        """() => {
                            const box = element => {
                                if (!element) return null;
                                const r = element.getBoundingClientRect();
                                return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};
                            };
                            const root = getComputedStyle(document.documentElement);
                            const view = document.querySelector('.enterprise-view');
                            const main = view.querySelector('main');
                            const heading = main.querySelector('.page-heading,.workbench-hero');
                            const help = document.querySelector('.enterprise-help-link');
                            return {
                                body:box(document.querySelector('.enterprise-body')),
                                view:box(view),
                                inner:box(main.querySelector('.enterprise-page-inner,.workbench-inner')),
                                heading:box(heading),
                                titleSize:getComputedStyle(heading.querySelector('h1')).fontSize,
                                titleCount:main.querySelectorAll('h1').length,
                                admin:box(document.querySelector('.enterprise-admin-tabs')),
                                firstAdminLink:box(document.querySelector('.enterprise-admin-tabs>a')),
                                help:box(help),
                                helpInFooter:Boolean(help.closest('.enterprise-sidebar-footer')),
                                helpSvg:help.querySelector('svg')?.getAttribute('fill') === 'none',
                                firstMenuIcon:box(document.querySelector('.enterprise-primary>a>svg')),
                                helpIcon:box(help.querySelector('svg')),
                                footer:box(document.querySelector('.enterprise-sidebar-footer')),
                                sidebarInert:document.querySelector('.enterprise-sidebar').inert,
                                retiredMarkup:document.querySelectorAll('.enterprise-topbar,.preview-mode-badge,.workbench-kicker,.workbench-orbit,.page-heading .eyebrow').length,
                                padTop:parseFloat(root.getPropertyValue('--page-padding-top')),
                                padX:parseFloat(root.getPropertyValue('--page-padding-x')),
                                maxWidth:parseFloat(root.getPropertyValue('--page-max-width')),
                                titleToken:root.getPropertyValue('--page-title-size').trim(),
                                accent:root.getPropertyValue('--accent').trim(),
                                horizontalOverflow:document.documentElement.scrollWidth > innerWidth + 1 || main.scrollWidth > main.clientWidth + 1,
                            };
                        }"""
                    )
                    body, view = geometry["body"], geometry["view"]
                    inner, heading = geometry["inner"], geometry["heading"]
                    admin = geometry["admin"]
                    assert geometry["retiredMarkup"] == 0, (route, geometry)
                    assert not geometry["horizontalOverflow"], (route, geometry)
                    assert not geometry["sidebarInert"], (route, geometry)
                    assert geometry["titleCount"] == 1, (route, geometry)
                    assert geometry["titleSize"] == geometry["titleToken"]
                    assert abs(body["y"]) < 1
                    assert abs(view["y"] - (52 if admin else 0)) < 1
                    assert abs(view["height"] + view["y"] - height) < 1
                    assert abs(heading["y"] - view["y"] - geometry["padTop"]) < 1
                    expected_width = min(
                        geometry["maxWidth"], body["width"] - 2 * geometry["padX"]
                    )
                    expected_x = body["x"] + (body["width"] - expected_width) / 2
                    assert abs(inner["width"] - expected_width) < 1
                    assert abs(inner["x"] - expected_x) < 1
                    assert abs(heading["x"] - expected_x) < 1
                    if admin:
                        assert abs(admin["y"]) < 1
                        assert abs(admin["height"] - 52) < 1
                        assert abs(geometry["firstAdminLink"]["x"] - expected_x) < 1
                    assert geometry["helpInFooter"] and geometry["helpSvg"]
                    assert geometry["help"]["y"] >= 0
                    assert geometry["footer"]["bottom"] <= height + 1
                    icon, menu = geometry["helpIcon"], geometry["firstMenuIcon"]
                    assert (
                        abs(
                            icon["x"]
                            + icon["width"] / 2
                            - menu["x"]
                            - menu["width"] / 2
                        )
                        < 1
                    )
                    assert geometry["accent"] == "#da724d"
                    layouts.append(
                        {"route": route, "width": width, "height": height, **geometry}
                    )
                    if (width, height) in AUDIT_SIZES:
                        await audit(f"{width}/{route}")
                        if route in {"workbench", "manage", "models"}:
                            await screenshot(f"{route}-{width}")
                passed(
                    f"{width}x{height}: eight pages share one heading and content grid; no topbar gap or overflow"
                )

            # Verify the actual CJK font, not just computed font-weight.
            await page.set_viewport_size({"width": 1440, "height": 1000})
            await go("workbench")
            client = await page.context.new_cdp_session(page)
            await client.send("DOM.enable")
            await client.send("CSS.enable")
            root = (await client.send("DOM.getDocument"))["root"]["nodeId"]
            for selector in [
                ".enterprise-primary>a.is-active>span",
                ".enterprise-primary>a:not(.is-active)>span",
            ]:
                node = (
                    await client.send(
                        "DOM.querySelector", {"nodeId": root, "selector": selector}
                    )
                )["nodeId"]
                faces = (
                    await client.send("CSS.getPlatformFontsForNode", {"nodeId": node})
                )["fonts"]
                # These labels contain Chinese only; allow local Noto, PingFang or YaHei faces.
                assert any(
                    face["glyphCount"] > 0 and "bold" in face["postScriptName"].lower()
                    for face in faces
                ), faces
                fonts.append({"selector": selector, "fonts": faces})
            passed(
                "persistent sidebar retains real CJK bold faces and the original orange/SVG rules"
            )

            for width, height in [(1440, 1000), (820, 1000), (390, 844), (820, 480)]:
                await page.set_viewport_size({"width": width, "height": height})
                await go("workbench")
                trigger = page.get_by_role("button", name="使用帮助", exact=True)
                await trigger.focus()
                await expect(trigger).to_be_in_viewport()
                await page.keyboard.press("Enter")
                dialog = page.get_by_role("dialog", name="使用帮助", exact=True)
                await expect(dialog).to_be_visible()
                await expect(trigger).to_have_attribute("aria-expanded", "true")
                await expect(dialog.locator(".guide-step")).to_have_count(4)
                for key in ["Tab"] * 14 + ["Shift+Tab"] * 14:
                    await page.keyboard.press(key)
                    assert await dialog.evaluate(
                        "element => element.contains(document.activeElement)"
                    )
                assert await dialog.evaluate(
                    "element => element.scrollWidth <= element.clientWidth + 1"
                )
                await audit(f"{width}x{height}/help")
                await screenshot(f"help-{width}x{height}")
                await page.keyboard.press("Escape")
                await expect(dialog).to_have_count(0)
                await expect(trigger).to_be_focused()
                await expect(trigger).to_have_attribute("aria-expanded", "false")
                await page.keyboard.press("Space")
                await expect(dialog).to_be_visible()
                await dialog.get_by_role("button", name="关闭帮助", exact=True).click()
                await expect(dialog).to_have_count(0)
                await expect(trigger).to_be_focused()
                if width == 1440:
                    await trigger.click()
                    await expect(dialog).to_be_visible()
                    await page.mouse.click(5, 5)
                    await expect(dialog).to_have_count(0)
                    await expect(trigger).to_be_focused()
                await trigger.click()
                await dialog.get_by_role(
                    "link", name="前往平台管理", exact=True
                ).click()
                await expect(dialog).to_have_count(0)
                await expect(page.locator(".release-boundary")).to_contain_text(
                    "不具备员工间会话访问隔离"
                )
                await expect(page.locator(".enterprise-admin-tabs>a")).to_have_count(4)
                passed(
                    f"{width}x{height}: footer help supports keyboard/close/focus return and real management navigation"
                )

            for width, height in [(1440, 1000), (820, 1000), (390, 844)]:
                await page.set_viewport_size({"width": width, "height": height})
                for tab in ["skills", "mcp"]:
                    await go("capabilities?tab=" + tab)
                    await expect(
                        page.locator(".capability-unavailable")
                    ).to_contain_text("尚未接入")
                    await audit(f"{width}/capabilities/{tab}")
                await go("chat")
                toolbar = page.locator(".chat-subbar")
                bounds = await toolbar.bounding_box()
                assert bounds and abs(bounds["y"]) < 1, bounds
                await expect(
                    toolbar.get_by_role("button", name="查看结果", exact=True)
                ).to_be_visible()
                await expect(
                    toolbar.get_by_role("button", name="查看过程", exact=True)
                ).to_be_visible()
                await audit(f"{width}/chat")
                await screenshot(f"chat-{width}")
            passed(
                "conversation toolbars start at the top; results/process controls and honest Skills/MCP states remain"
            )
            await go("conversations")
            await expect(page.locator(".preview-inline-note")).to_contain_text(
                "隔离尚未接入"
            )
            passed(
                "conversation centre still discloses the unfinished employee-isolation boundary"
            )
            await go("workbench")
            await page.get_by_label("任务输入").focus()
            await expect(page.locator(".task-composer")).to_have_css(
                "border-color", "rgb(214, 150, 122)"
            )
            await audit("composer-focus")
            assert not errors and not server_errors, (errors, server_errors)
            assert all(not state["violations"] for state in states), states
            passed(
                "no JavaScript errors, API 5xx, or checked automated accessibility violations"
            )
            report = {
                "result": "passed",
                "checkedAt": datetime.now(timezone.utc).isoformat(),
                "scope": "actual deployment; read-only business resources; no model calls, mock API responses, or employee-isolation acceptance; automated accessibility checks are not formal certification",
                "checks": len(checks),
                "items": checks,
                "layoutCount": len(layouts),
                "layouts": layouts,
                "accessibilityEnabled": bool(args.axe_script),
                "accessibilityStateCount": len(states),
                "accessibility": states,
                "platformFontFaces": fonts,
                "browserErrors": errors,
                "serverErrors": server_errors,
            }
            (destination / "page-layout-report.json").write_text(
                json.dumps(report, ensure_ascii=False, indent=2)
            )
            print(
                json.dumps(
                    {
                        "result": "passed",
                        "checks": len(checks),
                        "layouts": len(layouts),
                        "accessibilityStates": len(states),
                    }
                ),
                flush=True,
            )
        except Exception:
            if await page.locator("#password").count():
                await page.locator("#password").fill("")
            await screenshot("layout-failure")
            (destination / "layout-failure.json").write_text(
                json.dumps(
                    {
                        "layouts": layouts,
                        "accessibility": states,
                        "browserErrors": errors,
                        "serverErrors": server_errors,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            raise
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main(options()))
