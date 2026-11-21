#!/usr/bin/env python3
"""Exercise catalog order, date labels, filtering and layout using a stubbed API.

Start the frontend dev server; set FORGE_FRONTEND_URL and FORGE_BROWSER_PATH if needed.
"""

import json
import os
import runpy
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

fixture = runpy.run_path(str(Path(__file__).with_name("check-composer-theme.py")))
responses = dict(fixture["responses"])
date = lambda day: f"2026-01-{day:02d}T00:00:00Z"  # noqa: E731


def scenario(id, name, status, created, published=None, official=False, pending=False):
    item = fixture["scenario"](id, name, "sparkles")
    item.update(
        {
            "space": "official" if official else "personal",
            "status": status,
            "createdAt": date(created),
            "updatedAt": date(30),
            "publishedAt": date(published) if published else None,
            "current_version": 2 if pending else 1,
            "published_version": 1 if status == "published" else 0,
            "published_payload": item["payload"] if status == "published" else None,
            "published_bundle_hash": "test",
            "tested": True,
        }
    )
    if pending:
        item["payload"] = {**item["payload"], "name": name + "草稿"}
    return item


def skill(id, name, created, published=None, pending=False):
    return {
        "id": id,
        "name": name,
        "machineName": f"skill-{id}",
        "description": "测试说明",
        "status": "draft" if pending or not published else "published",
        "createdAt": date(created),
        "updatedAt": date(30),
        "publishedAt": date(published) if published else None,
        "publishedRevisionId": id if published else None,
        "publishedVersion": 1 if published else None,
        "currentRevisionId": id,
        "files": [],
        "revision": 2,
        "tags": [],
    }


responses.update(
    {
        "/api/agent-scenarios": [
            scenario(1, "预置甲", "template", 30, official=True),
            scenario(2, "旧草稿", "draft", 10),
            scenario(3, "早发布", "published", 29, 15, pending=True),
            scenario(4, "新发布", "published", 1, 25),
            scenario(5, "历史发布", "published", 30),
            scenario(6, "新草稿", "draft", 28),
        ],
        "/api/skills": {
            "items": [
                skill(1, "技能待发布", 30, 10, True),
                skill(2, "技能新草稿", 27),
                skill(3, "技能新发布", 1, 25),
            ]
        },
        "/api/skills/published": {
            "items": [
                {
                    "id": 1,
                    "name": "技能待发布",
                    "machineName": "skill-1",
                    "description": "",
                    "version": 1,
                    "fileCount": 0,
                    "publishedAt": date(10),
                },
                {
                    "id": 3,
                    "name": "技能新发布",
                    "machineName": "skill-3",
                    "description": "",
                    "version": 1,
                    "fileCount": 0,
                    "publishedAt": date(25),
                },
            ]
        },
        "/api/registry/plugins": {"items": [], "submissions": [], "usageCounts": {}},
        "/api/registry/mcp-servers": {
            "items": [
                {
                    "id": 1,
                    "name": "MCP旧",
                    "createdAt": date(1),
                    "url": "",
                    "transport": "stdio",
                    "enabled": False,
                    "status": "unverified",
                    "lastError": "",
                    "tools": [],
                    "serverInfo": {},
                    "hasCredentials": False,
                },
                {
                    "id": 2,
                    "name": "MCP新",
                    "createdAt": date(25),
                    "url": "",
                    "transport": "stdio",
                    "enabled": False,
                    "status": "unverified",
                    "lastError": "",
                    "tools": [],
                    "serverInfo": {},
                    "hasCredentials": False,
                },
            ],
            "available": True,
            "reason": "",
        },
    }
)
URL = os.environ.get("FORGE_FRONTEND_URL", "http://127.0.0.1:5173")


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=os.environ.get("FORGE_BROWSER_PATH"),
            args=["--no-sandbox"],
        )
        context = browser.new_context()

        def api(route):
            path = urlsplit(route.request.url).path
            if not path.startswith("/api/"):
                route.continue_()
            else:
                assert path in responses, f"Unexpected API: {path}"
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({"code": 0, "data": responses[path]}),
                )

        context.route("**/api/**", api)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        for theme in ["light", "dark"]:
            for width in [1440, 390, 320]:
                page.set_viewport_size({"width": width, "height": 900})

                def go(path):
                    page.goto(URL + path)
                    page.evaluate(
                        "theme => localStorage.setItem('forge-theme', theme)", theme
                    )
                    page.reload()

                def cards(names):
                    titles = page.locator(".catalog-card h2")
                    expect(titles).to_have_text(names)
                    for card in page.locator(".catalog-card").all():
                        assert card.evaluate(
                            "e => e.scrollWidth <= e.clientWidth + 1"
                        ), card.inner_text()

                go("/agent/scenarios")
                cards(["新发布", "早发布", "历史发布", "预置甲"])
                expect(page.locator(".scenario-card").nth(2)).to_contain_text(
                    "发布日期未知"
                )
                expect(page.locator(".scenario-card").first).to_contain_text("发布于")
                page.get_by_role("button", name="维护场景").click()
                cards(
                    ["新草稿", "新发布", "早发布草稿", "旧草稿", "历史发布", "预置甲"]
                )
                expect(page.locator(".scenario-card").first).to_contain_text("创建于")
                expect(page.locator(".scenario-card").nth(2)).to_contain_text(
                    "草稿更新于"
                )
                page.get_by_label("搜索场景").fill("发布")
                cards(["新发布", "早发布草稿", "历史发布"])

                go("/agent/skills")
                cards(["技能新草稿", "技能新发布", "技能待发布"])
                expect(page.locator(".skill-card").nth(2)).to_contain_text("发布于")
                expect(page.locator(".skill-card").nth(2)).to_contain_text("草稿更新于")
                page.get_by_label("搜索技能").fill("新")
                cards(["技能新草稿", "技能新发布"])

                go("/agent/capabilities?tab=skills")
                cards(["技能新发布", "技能待发布"])
                expect(page.locator(".skill-card").first).to_contain_text("发布于")
                go("/agent/capabilities?tab=mcp")
                cards(["MCP新", "MCP旧"])
                expect(page.locator(".catalog-card").first).to_contain_text("接入于")
                assert not errors, errors
                print(f"PASS catalog UI {theme} {width}px")
        browser.close()


if __name__ == "__main__":
    main()
