#!/usr/bin/env python3
"""Check session panel tab and close-button alignment with a stubbed API.

Start the frontend dev server and install Playwright/Chromium. Set
FORGE_FRONTEND_URL or FORGE_BROWSER_PATH to override the defaults.
"""

import json
import os
import re
import runpy
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

responses = runpy.run_path(
    str(Path(__file__).with_name("check-human-message-layout.py"))
)["responses"]
responses["/api/agent/sessions/42"].update({"tokensIn": 0, "tokensOut": 0, "cost": 0})
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
            for width in [1440, 1280, 768, 390, 320]:
                page.set_viewport_size({"width": width, "height": 850})
                page.goto(URL + "/agent/chat/42")
                page.evaluate(
                    "theme => localStorage.setItem('forge-theme', theme)", theme
                )
                page.reload()
                expect(page.locator(".user-message-text")).to_have_count(4)
                page.locator(".chat-subbar .session-panel-button").last.click()
                panel = page.locator(".enterprise-session-panel")
                expect(panel).to_be_visible()
                tabs = panel.locator(".context-tabs")
                close = panel.get_by_role("button", name="关闭会话详情")
                for name in ["能力", "过程", "结果"]:
                    tab = tabs.get_by_role("button", name=name, exact=False)
                    tab.click()
                    expect(tab).to_have_class(re.compile("selected"))
                    metrics = tabs.evaluate("""e => {
                        const tabs = Array.from(e.querySelectorAll('button:not(.close-session-panel)'));
                        const close = e.querySelector('.close-session-panel');
                        const rect = el => { const r = el.getBoundingClientRect(); return {l:r.left,r:r.right,t:r.top,b:r.bottom,w:r.width,h:r.height,cy:(r.top+r.bottom)/2}; };
                        const selected = e.querySelector('button.selected');
                        const range = document.createRange(); range.selectNodeContents(selected.firstChild);
                        const label = range.getBoundingClientRect();
                        return {bar:rect(e), buttons:tabs.map(rect), close:rect(close), icon:rect(close.querySelector('svg')),
                          labelY:(label.top+label.bottom)/2, border:getComputedStyle(selected).borderBottomWidth};
                    }""")
                    assert abs(metrics["icon"]["cy"] - metrics["labelY"]) <= 3, metrics
                    assert (
                        metrics["close"]["w"] >= 36 and metrics["close"]["h"] >= 36
                    ), metrics
                    assert (
                        metrics["close"]["r"] <= metrics["bar"]["r"]
                        and metrics["close"]["l"] >= metrics["buttons"][-1]["r"]
                    ), metrics
                    assert metrics["border"] == "2px", metrics
                close.focus()
                page.keyboard.press("Enter")
                expect(panel).to_have_count(0)
                page.get_by_role("button", name="查看能力").click()
                expect(panel).to_be_visible()
                panel.get_by_role("button", name="关闭会话详情").click()
                expect(panel).to_have_count(0)
                print(f"OK: {theme}, {width}px, three tabs, keyboard and pointer close")
        browser.close()


if __name__ == "__main__":
    main()
