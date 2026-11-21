#!/usr/bin/env python3
"""Check short and long human bubbles in chat and the Skill editor with stubbed APIs.

Run a frontend dev server and install Playwright/Chromium first. Set
FORGE_FRONTEND_URL or FORGE_BROWSER_PATH to override their default locations.
"""

import json
import os
import runpy
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

root = Path(__file__).parent
composer = runpy.run_path(str(root / "check-composer-theme.py"))
skill = runpy.run_path(str(root / "check-skill-theme.py"))
responses = {**composer["responses"], **skill["responses"]}
messages = [
    {"id": 1, "role": "user", "content": "好", "meta": {}},
    {
        "id": 2,
        "role": "user",
        "content": "这是一条较长的消息，用来检查消息气泡的自适应宽度。",
        "meta": {},
    },
    {"id": 3, "role": "user", "content": "长消息" * 160, "meta": {}},
    {"id": 4, "role": "user", "content": "unbreakable" * 100, "meta": {}},
]
responses.update(
    {
        "/api/skills/1/authoring-session/latest": {"id": 1, "messages": messages},
        "/api/agent/sessions/42": {
            "id": 42,
            "title": "测试会话",
            "status": "idle",
            "messages": messages,
            "pendingApprovals": [],
            "bundle": {"meta": {}},
            "lastEventSeq": 0,
            "isTest": False,
        },
        "/api/agent/sessions/42/files": {"items": []},
        "/api/agent/sessions/42/trajectory": {"events": [], "nextCursor": 0},
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
            elif path.endswith("/events"):
                route.fulfill(
                    status=200, content_type="text/event-stream", body=": connected\n\n"
                )
            else:
                assert path in responses, f"Unexpected API request: {path}"
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({"code": 0, "data": responses[path]}),
                )

        context.route("**/api/**", api)
        page = context.new_page()
        for theme in ["light", "dark"]:
            for width in [1440, 390, 320]:
                page.set_viewport_size({"width": width, "height": 900})
                for path, selector, container in [
                    ("/agent/chat/42", ".user-message-text", ".message-row.user"),
                    ("/agent/skills/1", ".chat-message.user", ".chat-log"),
                ]:
                    page.goto(URL + path)
                    page.evaluate(
                        "theme => localStorage.setItem('forge-theme', theme)", theme
                    )
                    page.reload()
                    if path.startswith("/agent/skills") and width <= 900:
                        page.get_by_role("button", name="对话", exact=True).click()
                    bubbles = page.locator(selector)
                    expect(bubbles).to_have_count(4)
                    expect(bubbles.first).to_be_visible()
                    sizes = bubbles.evaluate_all(
                        """(elements, container) => elements.map(e => {
                          const r = e.getBoundingClientRect(), p = e.closest(container).getBoundingClientRect();
                          const s = getComputedStyle(e);
                          return {width:r.width, height:r.height, right:r.right, parentRight:p.right,
                            parentWidth:p.width, padding:s.padding, scroll:e.scrollWidth, client:e.clientWidth};
                        })""",
                        container,
                    )
                    short, medium, long, word = sizes
                    assert short["width"] < medium["width"] and short["width"] < 100, (
                        sizes
                    )
                    assert (
                        long["width"] <= long["parentWidth"]
                        and long["height"] > short["height"] * 2
                    ), sizes
                    assert word["scroll"] <= word["client"] + 1, sizes
                    assert all(b["padding"] == "6px 16px" for b in sizes), sizes
                    # Skill log has horizontal padding; all bubbles must share its right edge.
                    assert (
                        max(b["right"] for b in sizes) - min(b["right"] for b in sizes)
                        < 1
                    ), sizes
                    if path.startswith("/agent/chat"):
                        expect(page.get_by_label("复制消息")).to_have_count(4)
                        quotes = page.get_by_label("引用消息")
                        expect(quotes).to_have_count(4)
                        page.get_by_label("任务输入").fill("")
                        quotes.first.click()
                        expect(page.get_by_label("任务输入")).to_have_value("> 好\n\n")
                    print(f"OK: {theme}, {width}px, {path}")
        browser.close()


if __name__ == "__main__":
    main()
