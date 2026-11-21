#!/usr/bin/env python3
"""Workbench composer browser regression with stubbed API (no backend/model).

Start `npm --prefix frontend run dev`, install Playwright and Chromium, then run
`python3 scripts/check-composer-theme.py`. FORGE_FRONTEND_URL and FORGE_BROWSER_PATH
can override the server and browser executable.
"""

import json
import os
import runpy
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

shared = runpy.run_path(str(Path(__file__).with_name("check-admin-theme.py")))
responses = dict(shared["responses"])
capabilities = {
    "plugin_names": [],
    "plugin_tools": {},
    "builtin_tool_names": [],
    "skill_ids": [],
    "mcp_server_ids": [],
    "project_ids": [],
    "web_search": False,
}


def scenario(id, name, icon):
    payload = {
        "name": name,
        "description": "测试场景",
        "icon": icon,
        "prompt_template": "",
        "capabilities": capabilities,
        "model": "",
        "execution_mode": "standard",
    }
    return {
        "id": id,
        "space": "official",
        "status": "template",
        "payload": payload,
        "current_version": 1,
        "published_version": 1,
        "published_payload": None,
        "bundleHash": "test",
        "tested": True,
    }


responses.update(
    {
        "/api/agent-scenarios": [
            scenario(1, "通用助手", "sparkles"),
            scenario(2, "代码与研发", "code"),
            scenario(3, "文档与报告", "file"),
            scenario(4, "分析与决策", "chart"),
        ],
        "/api/agent/sessions": {"items": []},
        "/api/models/options": {
            "items": [
                {
                    "id": 1,
                    "name": "DeepSeek Flash",
                    "model": "deepseek-chat",
                    "contextWindow": 64000,
                    "inputPrice": None,
                    "outputPrice": None,
                    "isDefault": True,
                    "status": "ok",
                },
                {
                    "id": 2,
                    "name": "第二个模型",
                    "model": "test",
                    "contextWindow": 64000,
                    "inputPrice": None,
                    "outputPrice": None,
                    "isDefault": False,
                    "status": "ok",
                },
            ],
            "defaultId": 1,
        },
        "/api/code/projects": {
            "projects": [{"name": "forge", "branch": "main", "commit": "abcdef12"}]
        },
        "/api/capabilities/options": {
            "skills": [
                {
                    "id": 1,
                    "title": "代码审查",
                    "name": "review",
                    "version": 1,
                    "description": "",
                    "revisionId": 1,
                }
            ],
            "mcpServers": [],
            "web": {
                "available": False,
                "searchReady": False,
                "fetchEnabled": False,
                "reason": "未启用",
            },
        },
    }
)


def check_open_border(page, kind):
    open_selector = f".{kind}-select.ant-select-open .ant-select-selector"
    expect(page.locator(f".{kind}-select.ant-select-open")).to_have_count(1)
    page.wait_for_function(
        """selector => {
      const e = document.querySelector(selector);
      return e && getComputedStyle(e).borderTopColor === getComputedStyle(e.closest('.task-composer')).borderTopColor;
    }""",
        arg=open_selector,
    )
    bounds = page.locator(open_selector).evaluate("""e => {
        const r = e.getBoundingClientRect(), p = e.closest('.task-composer-options').getBoundingClientRect();
        const s = getComputedStyle(e);
        return {top: r.top - p.top, bottom: p.bottom - r.bottom,
          topColor: s.borderTopColor, bottomColor: s.borderBottomColor, topWidth: s.borderTopWidth,
          focus: getComputedStyle(e.closest('.task-composer')).borderTopColor};
    }""")
    assert bounds["top"] >= 1 and bounds["bottom"] >= 1, bounds
    assert (
        bounds["topWidth"] == "1px"
        and bounds["topColor"] == bounds["bottomColor"] == bounds["focus"]
    ), bounds


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=os.environ.get("FORGE_BROWSER_PATH"),
            args=["--no-sandbox"],
        )
        context = browser.new_context(viewport={"width": 1440, "height": 900})

        def api(route):
            path = urlsplit(route.request.url).path
            if not path.startswith("/api/"):
                route.continue_()
                return
            if path not in responses:
                raise AssertionError(f"Unexpected API request: {path}")
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"code": 0, "data": responses[path]}),
            )

        context.route("**/api/**", api)
        page = context.new_page()
        for theme in ["dark", "light"]:
            for width in [1440, 390, 320]:
                page.set_viewport_size({"width": width, "height": 900})
                page.goto(
                    os.environ.get("FORGE_FRONTEND_URL", "http://127.0.0.1:5173")
                    + "/agent/workbench"
                )
                page.evaluate(
                    '(theme) => localStorage.setItem("forge-theme", theme)', theme
                )
                page.reload()
                text = page.get_by_label("任务输入")
                expect(text).to_be_visible()
                expect(page.locator(".conversation-scenario-chip")).to_have_count(3)
                expect(page.get_by_text("Enter 发送", exact=False)).to_have_count(0)
                shared["check"](
                    page,
                    ".conversation-scenario-copy strong",
                    ".conversation-scenario-chip",
                    theme == "dark",
                )
                shared["check"](
                    page,
                    ".conversation-scenario-copy > span",
                    ".conversation-scenario-chip",
                    theme == "dark",
                )
                card = page.get_by_role("button", name="使用场景 代码与研发")
                card.hover()
                shared["check"](
                    page,
                    ".conversation-scenario-copy strong",
                    ".conversation-scenario-chip",
                    theme == "dark",
                )
                if os.environ.get("FORGE_COMPOSER_SCREENSHOTS"):
                    page.screenshot(
                        path=f"{os.environ['FORGE_COMPOSER_SCREENSHOTS']}/{theme}-{width}.png"
                    )
                expect(page.get_by_label("发送任务")).to_be_disabled()
                assert page.locator(".task-send").evaluate("""e => {
                    const probe = document.createElement('span');
                    probe.style.color = 'var(--scenario-selection-text)';
                    e.appendChild(probe);
                    const matches = getComputedStyle(probe).color === getComputedStyle(e).color;
                    probe.remove();
                    return matches;
                }""")
                assert (
                    page.locator(".model-select").evaluate(
                        "e => e.getBoundingClientRect().width"
                    )
                    == 175
                )
                assert (
                    page.locator(".task-send").evaluate(
                        "e => getComputedStyle(e).borderRadius"
                    )
                    == "50%"
                )
                shared["check"](
                    page,
                    ".model-select .ant-select-selection-item",
                    ".task-composer",
                    theme == "dark",
                )
                shared["check"](
                    page, ".task-send:disabled", ".task-send:disabled", None, minimum=3
                )
                text.fill("第一行")
                text.press("Shift+Enter")
                text.type("第二行")
                expect(text).to_have_value("第一行\n第二行")
                text.fill("保留这段草稿")
                expect(page.get_by_label("发送任务")).to_be_enabled()
                page.get_by_role("button", name="使用场景 代码与研发").click()
                expect(text).to_have_value("保留这段草稿")
                expect(card).to_have_attribute("aria-pressed", "true")
                shared["check"](
                    page,
                    ".conversation-scenario-copy strong",
                    ".conversation-scenario-chip",
                    theme == "dark",
                )
                options = page.locator(".task-composer-options")
                info = options.evaluate(
                    "e => ({scroll: e.scrollWidth, width: e.clientWidth, wrap: getComputedStyle(e).flexWrap})"
                )
                assert info["wrap"] == "nowrap", info
                if width < 500:
                    assert info["scroll"] > info["width"], info
                send = page.get_by_label("发送任务").bounding_box()
                toolbar = page.locator(".task-composer-toolbar").bounding_box()
                assert send["x"] + send["width"] <= toolbar["x"] + toolbar["width"] + 1
                assert abs(send["width"] - send["height"]) < 1
                attachment = page.get_by_label("附加文本文件").bounding_box()
                assert 0 <= send["x"] - (attachment["x"] + attachment["width"]) <= 10
                assert (
                    abs(
                        attachment["y"]
                        + attachment["height"] / 2
                        - send["y"]
                        - send["height"] / 2
                    )
                    < 1
                )
                page.get_by_label("选择场景", exact=True).click()
                check_open_border(page, "scenario")
                page.get_by_label("选择模型").click()
                check_open_border(page, "model")
                if os.environ.get("FORGE_COMPOSER_SCREENSHOTS"):
                    page.screenshot(
                        path=f"{os.environ['FORGE_COMPOSER_SCREENSHOTS']}/{theme}-{width}-open.png"
                    )
                page.get_by_text("第二个模型", exact=True).last.click()
                expect(text).to_have_value("保留这段草稿")
                page.get_by_role("button", name="关联代码", exact=True).click()
                page.get_by_text("forge", exact=True).last.click()
                expect(page.locator(".picker-trigger.is-active")).to_contain_text(
                    "forge"
                )
                page.get_by_role("button", name="扩展技能", exact=True).click()
                page.get_by_text("代码审查", exact=True).last.click()
                expect(page.locator(".picker-trigger.is-active")).to_have_count(2)
                page.locator("input[type=file]").set_input_files(
                    {
                        "name": "very-long-attachment-name.txt",
                        "mimeType": "text/plain",
                        "buffer": b"example",
                    }
                )
                expect(page.locator(".attachment-name")).to_have_text(
                    "very-long-attachment-name.txt"
                )
                expect(text).to_have_value("保留这段草稿")
                text.click()
                page.get_by_role("button", name="使用场景 文档与报告").click()
                expect(text).to_have_value("保留这段草稿")
                expect(page.locator(".attachment-name")).to_have_text(
                    "very-long-attachment-name.txt"
                )
                print(
                    f"PASS {theme} {width}px: single row, pinned send, selections, attachment, draft"
                )
        browser.close()


if __name__ == "__main__":
    main()
