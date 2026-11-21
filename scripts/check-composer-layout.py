#!/usr/bin/env python3
"""Compare workbench layout against the prior CSS with a stubbed API.

Start `npm --prefix frontend run dev` and run with Playwright/Chromium installed.
FORGE_FRONTEND_URL and FORGE_BROWSER_PATH may override the defaults.
"""

import json
import os
import runpy
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

responses = runpy.run_path(str(Path(__file__).with_name("check-composer-theme.py")))[
    "responses"
]
URL = os.environ.get("FORGE_FRONTEND_URL", "http://127.0.0.1:5173")
BROWSER = os.environ.get("FORGE_BROWSER_PATH")
# Restore only the changed baseline values, in the same rendered page, so typography,
# data and browser metrics are identical to the current layout.
BASELINE = """
.conversation-start-surface { padding-bottom: clamp(64px, 19vh, 188px) !important; }
.enterprise-chat .chat-subbar { height: 62px !important; }
@media (max-width: 700px), (max-height: 640px) {
  .conversation-start-surface { padding-bottom: 36px !important; }
}
@media (max-width: 480px) { .enterprise-chat .chat-subbar { height: 55px !important; } }
"""


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True, executable_path=BROWSER, args=["--no-sandbox"]
        )
        context = browser.new_context()

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
            for route in ["/agent/workbench", "/agent/chat"]:
                for width, height in [
                    (1440, 900),
                    (1440, 768),
                    (1366, 720),
                    (1920, 1080),
                    (1440, 600),
                    (390, 844),
                    (320, 568),
                ]:
                    page.set_viewport_size({"width": width, "height": height})
                    page.goto(URL + route)
                    page.evaluate(
                        "value => localStorage.setItem('forge-theme', value)", theme
                    )
                    page.reload()
                    expect(page.get_by_label("任务输入")).to_be_visible()
                    expect(page.locator(".conversation-scenario-chip")).to_have_count(3)
                    current = page.evaluate("""() => {
                      const bounds = s => { const r = document.querySelector(s).getBoundingClientRect();
                        return {top:r.top, bottom:r.bottom, height:r.height}; };
                      const size = s => getComputedStyle(document.querySelector(s)).fontSize;
                      return { composer:bounds('.task-composer'), heading:bounds('.conversation-start-heading'),
                        cards:bounds('.conversation-start-discover'),
                        bar:document.querySelector('.chat-subbar') ? bounds('.chat-subbar') : null,
                        code:size('[aria-label="关联代码"]'), skills:size('[aria-label="扩展技能"]'),
                        overflow:document.documentElement.scrollWidth > innerWidth + 1 };
                    }""")
                    assert current["code"] == current["skills"] == "13px", current
                    assert not current["overflow"], current
                    if route == "/agent/chat":
                        assert (
                            abs(current["bar"]["height"] - (52 if width <= 480 else 55))
                            < 0.5
                        ), current
                        for name in ["查看结果", "查看能力"]:
                            button = page.get_by_role("button", name=name)
                            expect(button).to_be_visible()
                            box = button.bounding_box()
                            assert (
                                box["y"] >= current["bar"]["top"]
                                and box["y"] + box["height"]
                                <= current["bar"]["bottom"] + 1
                            )
                    baseline = page.add_style_tag(content=BASELINE)
                    old = page.evaluate("""() => {
                      const top = s => document.querySelector(s).getBoundingClientRect().top;
                      return { composer:top('.task-composer'), heading:top('.conversation-start-heading'),
                               cards:top('.conversation-start-discover') };
                    }""")
                    baseline.evaluate("e => e.remove()")
                    if width > 700 and height > 640:
                        shifts = [
                            current[key]["top"] - old[key]
                            for key in ["composer", "heading", "cards"]
                        ]
                        assert all(24 <= shift <= 40 for shift in shifts), (
                            route,
                            width,
                            height,
                            shifts,
                        )
                        assert max(shifts) - min(shifts) < 1, shifts
                        assert current["cards"]["bottom"] <= height + 1, current
                    else:
                        # Small/short viewports prioritize access, not a forced downward shift.
                        shift = current["composer"]["top"] - old["composer"]
                        assert abs(shift) <= (7 if route == "/agent/chat" else 1), shift
                    page.get_by_label("任务输入").fill("保留内容")
                    card = page.get_by_role("button", name="使用场景 代码与研发")
                    card.scroll_into_view_if_needed()
                    card.click()
                    expect(page.get_by_label("任务输入")).to_have_value("保留内容")
                    print(f"PASS {theme} {route} {width}x{height}")
        browser.close()


if __name__ == "__main__":
    main()
