#!/usr/bin/env python3
"""Check Skill editor themes with a stubbed API, not a real backend or model.

Start `npm --prefix frontend run dev`, install Playwright/Chromium, then run
`python3 scripts/check-skill-theme.py`. FORGE_FRONTEND_URL and FORGE_BROWSER_PATH
can override the server and browser executable.
"""

import json
import os
import runpy
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

# Reuse the admin theme regression's API scaffolding and WCAG contrast calculation.
shared = runpy.run_path(str(Path(__file__).with_name("check-admin-theme.py")))
URL = os.environ.get("FORGE_FRONTEND_URL", "http://127.0.0.1:5173")
BROWSER = os.environ.get("FORGE_BROWSER_PATH")
check = shared["check"]
responses = {**shared["responses"], "/api/agent/sessions": {"items": []}}
reference = {"filename": "guide.md", "path": "references/guide.md", "bytes": 50}
content = "---\nname: test-skill\ntitle: 测试技能\ndescription: 测试用途\n---\n\n# 测试技能\n\n正文"
skill = {
    "id": 1,
    "name": "测试技能",
    "machineName": "test-skill",
    "description": "测试用途",
    "status": "draft",
    "tags": [],
    "currentRevisionId": 2,
    "publishedVersion": 1,
    "content": content,
    "referenceFiles": [reference],
    "updatedAt": "2026-11-21T14:13:47Z",
}
revisions = [
    {
        "id": 2,
        "revision": 2,
        "publishedVersion": None,
        "source": "manual",
        "changeSummary": "最新修改",
        "createdAt": "2026-11-21T14:13:47Z",
        "content": content,
    },
    {
        "id": 1,
        "revision": 1,
        "publishedVersion": 1,
        "source": "publish",
        "changeSummary": "正式发布",
        "createdAt": "2026-11-20T14:13:47Z",
        "content": content,
    },
]
responses.update(
    {
        "/api/skills/1": skill,
        "/api/skills/1/revisions": {"items": revisions},
        "/api/skills/1/authoring-session/latest": None,
        "/api/skills/1/references/2/0": {"content": "# 参考资料\n\n示例内容"},
    }
)


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True, executable_path=BROWSER, args=["--no-sandbox"]
        )
        context = browser.new_context(viewport={"width": 1440, "height": 900})

        def api(route):
            path = urlsplit(route.request.url).path
            if not path.startswith("/api/"):
                route.continue_()
            elif path not in responses:
                raise AssertionError(f"Unexpected API request: {path}")
            else:
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({"code": 0, "data": responses[path]}),
                )

        context.route("**/api/**", api)
        page = context.new_page()
        for preference, system, dark in [
            ("dark", "light", True),
            ("light", "dark", False),
            ("system", "dark", True),
            ("system", "light", False),
        ]:
            page.emulate_media(color_scheme=system)
            page.goto(URL + "/agent/skills/1")
            page.evaluate(
                "value => localStorage.setItem('forge-theme', value)", preference
            )
            page.reload()
            selected = page.locator(".file-row.selected")
            expect(selected).to_have_attribute("aria-current", "page")
            check(page, ".file-row.selected", ".file-row.selected", dark)
            check(
                page, ".view-switch button.active", ".view-switch button.active", dark
            )
            page.locator(".folder-row").hover()
            check(page, ".folder-row", ".folder-row", dark)
            check(page, ".file-row.selected svg", ".file-row.selected", dark)
            page.get_by_label("给 Skill 助手的要求").focus()
            check(page, ".chat-composer textarea", ".composer-box", dark)
            check(
                page,
                ".composer-send:disabled",
                ".composer-send:disabled",
                dark=None,
                minimum=3,
            )
            page.locator(".chat-empty > button").first.hover()
            check(page, ".chat-empty > button", ".chat-empty > button", dark)

            page.get_by_role("button", name="预览", exact=True).click()
            expect(
                page.get_by_role("button", name="预览", exact=True)
            ).to_have_attribute("aria-pressed", "true")
            check(
                page, ".view-switch button.active", ".view-switch button.active", dark
            )
            page.get_by_role("button", name="guide.md", exact=True).click()
            expect(page.locator(".reference-row.selected")).to_have_attribute(
                "aria-current", "page"
            )
            expect(page.get_by_role("heading", name="参考资料")).to_be_visible()
            check(page, ".reference-row.selected", ".reference-row.selected", dark)
            page.get_by_role("button", name="编辑", exact=True).click()
            expect(
                page.get_by_role("button", name="编辑", exact=True)
            ).to_have_attribute("aria-pressed", "true")
            page.get_by_role("button", name="SKILL.md", exact=True).click()

            page.get_by_role("button", name="历史", exact=True).click()
            expect(page.get_by_text("版本历史", exact=True)).to_be_visible()
            expect(page.locator(".history-row")).to_have_count(2)
            # The current revision must stay readable on hover, as well as on keyboard focus.
            page.locator(".history-row").first.hover()
            page.wait_for_timeout(200)
            for selector in [
                ".history-identity strong",
                ".history-summary",
                ".history-time",
                ".history-source",
                ".history-actions .ant-btn",
            ]:
                check(
                    page,
                    f".history-row:first-child {selector}",
                    ".history-row:first-child",
                    dark,
                )
            check(
                page,
                ".history-row:first-child .history-tag",
                ".history-row:first-child .history-tag",
                dark,
            )
            page.locator(".history-row").nth(1).hover()
            page.wait_for_timeout(200)  # allow the hover transition to finish
            check(
                page,
                ".history-row:nth-child(2) .history-summary",
                ".history-row:nth-child(2)",
                dark,
            )
            check(
                page,
                ".history-row:nth-child(2) .history-tag-published",
                ".history-row:nth-child(2) .history-tag-published",
                dark,
            )
            expect(
                page.locator(".history-row").nth(1).get_by_role("button", name="恢复")
            ).to_be_visible()
            page.locator(".history-row").nth(0).get_by_role(
                "button", name="查看"
            ).focus()
            page.wait_for_timeout(200)
            check(
                page,
                ".history-row:first-child .history-summary",
                ".history-row:first-child",
                dark,
            )
            page.locator(".history-row").nth(1).get_by_role(
                "button", name="查看"
            ).click()
            expect(page.locator(".history-preview-content")).to_contain_text("测试技能")
            check(page, ".history-preview-content", ".history-preview-content", dark)
            page.locator(".history-preview-modal .ant-modal-close").click()
            expect(page.locator(".history-preview-content")).not_to_be_visible()
            page.locator(".ant-drawer-close").click()
            print(f"PASS Skill editor: preference={preference}, system={system}")

        # Theme changes from the account menu update the mounted editor immediately.
        page.get_by_role("button", name="admin，账号菜单").click()
        page.get_by_role("menuitemradio", name="深色").click()
        check(page, ".file-row.selected", ".file-row.selected", True)
        page.get_by_role("button", name="admin，账号菜单").click()
        page.get_by_role("menuitemradio", name="跟随系统").click()
        check(page, ".file-row.selected", ".file-row.selected", False)
        page.set_viewport_size({"width": 390, "height": 844})
        page.emulate_media(color_scheme="dark")
        page.goto(URL + "/agent/skills/1")
        expect(page.locator(".file-row.selected")).to_be_visible()
        check(page, ".file-row.selected", ".file-row.selected", True)
        page.get_by_role("button", name="对话", exact=True).click()
        page.locator(".chat-empty > button").first.hover()
        check(page, ".chat-empty > button", ".chat-empty > button", True)
        print("PASS Skill editor: mobile system dark")
        browser.close()


if __name__ == "__main__":
    main()
