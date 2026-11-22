#!/usr/bin/env python3
"""Browser regression for the governance and audit themes (stubbed API, no backend required).

Start the frontend with `npm --prefix frontend run dev`, install Playwright and Chromium,
then run `python3 scripts/check-admin-theme.py`. Set FORGE_BROWSER_PATH to use a
specific Chromium executable, or FORGE_FRONTEND_URL to change the server URL.
"""

import json
import os
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

URL = os.environ.get("FORGE_FRONTEND_URL", "http://127.0.0.1:5173")
BROWSER = os.environ.get("FORGE_BROWSER_PATH")


session = {
    "id": 3,
    "sessionId": 3,
    "title": "审计记录样例",
    "scenarioName": "通用助手",
    "scenarioVersion": 1,
    "status": "error",
    "tokensIn": 100,
    "tokensOut": 25,
    "createdAt": "2026-11-21T14:13:47Z",
    "isTest": False,
}
policy = {
    "allowedTools": ["workspace_read"],
    "allowedPluginTools": ["*"],
    "maxOutputTokens": 16384,
    "requestTimeoutSeconds": 300,
    "approvalTimeoutSeconds": 120,
    "fileRetentionDays": 30,
}
web = {
    "enabled": True,
    "provider": "deepseek-official",
    "providers": [{"id": "deepseek-official", "label": "DeepSeek"}],
    "baseUrl": "",
    "apiKeyConfigured": True,
    "keySource": "custom",
    "fetchEnabled": True,
    "searchReady": True,
    "available": True,
    "reason": "",
}
responses = {
    "/api/auth/session": {
        "authenticated": True,
        "user": {"name": "Admin", "username": "admin", "workspace": "test"},
    },
    "/api/agent-scenarios": [],
    "/api/agent/sessions": {"items": [session]},
    "/api/audit/sessions": {"items": [session]},
    "/api/registry/tools": {
        "items": [{"name": "workspace_read", "title": "读取文件", "icon": "folder"}]
    },
    "/api/models/connection": {"configured": False},
    "/api/models/options": {"items": [], "defaultId": None},
    "/api/runtime/status": {
        "runner": {"status": "online"},
        "storage": "SQLite",
        "limitations": ["仅供测试"],
    },
    "/api/governance/policies": policy,
    "/api/governance/web-search": web,
    "/api/governance/storage": {
        "files": 1,
        "bytes": 1024,
        "sessions": 1,
        "storedBytes": 1024,
        "lastCleanup": None,
    },
}

# Blend translucent backgrounds onto their ancestors before measuring contrast.
CONTRAST = r"""([textSelector, backgroundSelector]) => {
  const text = document.querySelector(textSelector);
  const background = document.querySelector(backgroundSelector);
  if (!text || !background) throw new Error(`Missing: ${textSelector} / ${backgroundSelector}`);
  const rgba = value => {
    const parts = value.match(/[\d.]+/g).map(Number);
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
  };
  const blend = (fg, bg) => fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));
  let layers = [], el = background;
  while (el) { layers.push(rgba(getComputedStyle(el).backgroundColor)); el = el.parentElement; }
  let bg = [255, 255, 255];
  for (const layer of layers.reverse()) bg = blend(layer, bg);
  const fg = blend(rgba(getComputedStyle(text).color), bg);
  const luminance = rgb => rgb.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
  const values = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return { ratio: (values[0] + 0.05) / (values[1] + 0.05), bg };
}"""


def check(page, text, background, dark, minimum=4.5):
    result = page.evaluate(CONTRAST, [text, background])
    assert result["ratio"] >= minimum, f"Low contrast {text} / {background}: {result}"
    # Page cards and table headers must actually switch surfaces, not just text colors.
    if dark is not None:
        brightness = sum(result["bg"]) / 3
        assert brightness < 80 if dark else brightness > 200, (
            f"Wrong surface {background}: {result}"
        )


def main():
    requests = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True, executable_path=BROWSER, args=["--no-sandbox"]
        )
        context = browser.new_context(
            viewport={"width": 1440, "height": 900}, color_scheme="dark"
        )

        def api(route):
            path = urlsplit(route.request.url).path
            if not path.startswith("/api/"):
                route.continue_()
                return
            requests.append((route.request.method, path))
            data = responses.get(path)
            if data is None:
                raise AssertionError(f"Unexpected API request: {path}")
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"code": 0, "data": data}),
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
            page.goto(URL + "/agent/audit")
            page.evaluate(
                "value => localStorage.setItem('forge-theme', value)", preference
            )
            page.reload()
            page.locator(".audit-table-card").get_by_text(
                "审计记录样例", exact=True
            ).wait_for()
            check(page, ".audit-metrics strong", ".audit-metrics article", dark)
            check(page, ".audit-metrics article > span", ".audit-metrics article", dark)
            check(page, "tbody td strong", ".audit-table-card", dark)
            check(page, "thead th", "thead th", dark)
            check(page, ".text-link", ".audit-table-card", dark)
            check(page, ".audit-toolbar input", ".audit-toolbar .search-field", dark)
            check(page, ".audit-toolbar select", ".audit-toolbar select", dark)
            page.locator("tbody tr").hover()
            check(page, "tbody td strong", "tbody td", dark)
            page.get_by_label("搜索审计记录").fill("无匹配记录")
            assert page.get_by_text("没有匹配的记录").is_visible()
            page.get_by_label("搜索审计记录").fill("")
            page.get_by_label("筛选会话状态").select_option("archived")
            assert (
                page.locator(".audit-table-card")
                .get_by_text("审计记录样例", exact=True)
                .count()
                == 0
            )

            page.goto(URL + "/agent/governance")
            page.get_by_text("工具与审批").wait_for()
            page.get_by_text("联网搜索", exact=True).wait_for()
            check(
                page,
                ".governance-form .settings-section-heading h2",
                ".governance-form",
                dark,
            )
            check(page, ".tool-checkbox strong", ".tool-checkbox", dark)
            check(page, ".deployment-card h2", ".deployment-card", dark)
            check(page, ".storage-summary dt", ".storage-summary", dark)
            check(page, ".web-search-card .link-button", ".web-search-card", dark)
            check(
                page,
                ".governance-form button.primary",
                ".governance-form button.primary",
                dark=None,
            )
            check(
                page,
                ".web-search-card .ant-input",
                ".web-search-card .ant-input-affix-wrapper",
                dark,
            )
            page.get_by_role("switch", name="允许受管插件工具").click()
            page.get_by_role("button", name="保存策略").click()
            page.wait_for_timeout(200)
            assert ("PUT", "/api/governance/policies") in requests
            print(f"PASS admin themes: preference={preference}, system={system}")

        page.set_viewport_size({"width": 390, "height": 844})
        page.emulate_media(color_scheme="dark")
        page.goto(URL + "/agent/audit")
        page.locator(".audit-table-card").get_by_text(
            "审计记录样例", exact=True
        ).wait_for()
        check(page, "tbody td strong", ".audit-table-card", True)
        assert page.get_by_label("搜索审计记录").is_visible()
        page.goto(URL + "/agent/governance")
        page.get_by_text("工具与审批").wait_for()
        check(
            page,
            ".governance-form .settings-section-heading h2",
            ".governance-form",
            True,
        )
        assert page.get_by_role("button", name="保存策略").is_visible()
        print("PASS admin themes: mobile, system dark")
        browser.close()


if __name__ == "__main__":
    main()
