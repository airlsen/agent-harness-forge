#!/usr/bin/env python3
"""Browser regression for the first-turn transition with stubbed API/SSE.

Start `npm --prefix frontend run dev`, install Playwright and Chromium, and run
`python3 scripts/check-composer-transition.py`. No real backend or model is used.
"""

import asyncio
import json
import os
import re
import runpy
from pathlib import Path
from urllib.parse import urlsplit

from playwright.async_api import async_playwright, expect

fixture = runpy.run_path(str(Path(__file__).with_name("check-composer-theme.py")))
URL = os.environ.get("FORGE_FRONTEND_URL", "http://127.0.0.1:5173")
BROWSER = os.environ.get("FORGE_BROWSER_PATH")


async def run_case(browser, path, width, reduced, fails_first=False):
    responses = dict(fixture["responses"])
    responses["/api/models/connection"] = {"configured": True}
    session = {
        "id": 42,
        "sessionId": 42,
        "scenarioId": 1,
        "scenarioName": "通用助手",
        "scenarioVersion": 1,
        "modelId": 1,
        "model": "deepseek-chat",
        "modelName": "DeepSeek Flash",
        "modelContextWindow": 64000,
        "title": "新任务",
        "status": "idle",
        "lastEventSeq": 0,
        "messages": [],
        "pendingApprovals": [],
        "bundle": {"meta": {}},
        "tokensIn": 0,
        "tokensOut": 0,
        "cost": None,
        "isTest": False,
        "createdAt": "2026-11-21T00:00:00Z",
    }
    context = await browser.new_context(
        viewport={"width": width, "height": 900},
        reduced_motion="reduce" if reduced else "no-preference",
    )
    await context.add_init_script("""(() => {
      window.composerMotions = [];
      const original = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) {
        if (this.matches('.enterprise-composer-area .task-composer'))
          window.composerMotions.push({frames, options});
        return original.call(this, frames, options);
      };
    })()""")
    gate = asyncio.Event()
    received = asyncio.Event()
    turns = []
    fail = fails_first
    settled = False

    async def api(route):
        nonlocal fail
        req = route.request
        urlpath = urlsplit(req.url).path
        if not urlpath.startswith("/api/"):
            await route.continue_()
            return
        if urlpath.endswith("/events"):
            body = "event: settled\ndata: {}\n\n" if settled else ": connected\n\n"
            await route.fulfill(status=200, content_type="text/event-stream", body=body)
            return
        if urlpath == "/api/agent/sessions" and req.method == "POST":
            data = session
        elif urlpath == "/api/agent/sessions/42/turns" and req.method == "POST":
            turns.append(req.post_data_json)
            received.set()
            await gate.wait()
            if fail:
                fail = False
                await route.fulfill(
                    status=409,
                    content_type="application/json",
                    body=json.dumps({"message": "提交失败"}),
                )
                return
            session["messages"].append(
                {
                    "id": len(turns),
                    "role": "user",
                    "content": turns[-1]["message"],
                    "meta": {},
                }
            )
            data = {
                "messageId": len(turns),
                "cursor": 0,
                "messageMeta": {},
                "codeProjects": [],
                "capabilities": {
                    "skillIds": [],
                    "mcpServerIds": [],
                    "webSearch": False,
                },
            }
        elif urlpath == "/api/agent/sessions/42/files":
            data = {"items": []}
        elif urlpath == "/api/agent/sessions/42/trajectory":
            data = {"events": [], "nextCursor": 0}
        elif urlpath == "/api/agent/sessions/42":
            data = session
        else:
            assert urlpath in responses, (
                f"Unexpected API request: {req.method} {urlpath}"
            )
            data = responses[urlpath]
        await route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"code": 0, "data": data}),
        )

    await context.route("**/api/**", api)
    page = await context.new_page()
    await page.goto(URL + path)
    text = page.get_by_label("任务输入")
    await expect(text).to_be_visible()
    await text.fill("这是不会丢失的测试草稿")
    await page.locator("input[type=file]").set_input_files(
        {"name": "note.txt", "mimeType": "text/plain", "buffer": b"hello"}
    )
    await page.get_by_label("发送任务").click()
    await asyncio.wait_for(received.wait(), timeout=10)
    assert urlsplit(page.url).path == path
    assert await page.evaluate("window.composerMotions.length") == 0
    await expect(text).to_have_value("这是不会丢失的测试草稿")
    await expect(page.locator(".attachment-name")).to_have_text("note.txt")
    gate.set()
    if fails_first:
        await expect(page.get_by_text("提交失败", exact=False).first).to_be_visible()
        await expect(text).to_have_value("这是不会丢失的测试草稿")
        await expect(page.locator(".attachment-name")).to_have_text("note.txt")
        assert urlsplit(page.url).path == path
        assert await page.evaluate("window.composerMotions.length") == 0
        await page.get_by_label("发送任务").click()
    await page.wait_for_url("**/agent/chat/42")
    await expect(
        page.locator(".enterprise-composer-area .task-composer")
    ).to_be_visible()
    await expect(
        page.get_by_text("这是不会丢失的测试草稿", exact=False).first
    ).to_be_visible()
    await page.evaluate(
        "() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
    )
    motions = await page.evaluate("window.composerMotions")
    expected = width > 700 and not reduced
    assert len(motions) == (1 if expected else 0), motions
    if expected:
        frames = motions[0]["frames"]
        assert (
            "translate(" in frames[0]["transform"]
            and frames[-1]["transform"] == "translate(0, 0) scale(1, 1)"
        )
        movement = re.search(
            r"translate\([^,]+,\s*(-?[\d.]+)px\)", frames[0]["transform"]
        )
        assert movement and float(movement.group(1)) < 0, frames
        assert motions[0]["options"]["duration"] == 320
        await page.wait_for_function(
            "!document.querySelector('body > .conversation-start-heading[aria-hidden=true]')"
        )
    assert len(turns) == (2 if fails_first else 1), turns
    assert (
        turns[-1]["message"].startswith("这是不会丢失的测试草稿")
        and "note.txt" in turns[-1]["message"]
    )
    # Follow-up turns and opening existing history must not replay the welcome transition.
    session["status"] = "idle"
    settled = True
    reply = page.get_by_label("任务输入")
    await expect(reply).to_be_enabled(timeout=10000)
    await reply.fill("第二轮")
    await page.get_by_label("发送任务").click()
    await expect(page.get_by_text("第二轮", exact=True).first).to_be_visible()
    assert await page.evaluate("window.composerMotions.length") == (
        1 if expected else 0
    )
    assert len(turns) == (3 if fails_first else 2)
    await page.goto(URL + "/agent/chat/42")
    await expect(page.get_by_text("第二轮", exact=True).first).to_be_visible()
    assert await page.evaluate("window.composerMotions.length") == 0
    print(
        f"PASS {path} width={width} reduced={reduced} retry={fails_first}: acceptance, draft and motion"
    )
    await context.close()


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            headless=True, executable_path=BROWSER, args=["--no-sandbox"]
        )
        for args in [
            ("/agent/workbench", 1440, False, True),
            ("/agent/chat", 1440, False, False),
            ("/agent/workbench", 1440, True, False),
            ("/agent/workbench", 390, False, False),
        ]:
            await run_case(browser, *args)
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
