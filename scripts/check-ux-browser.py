#!/usr/bin/env python3
"""Browser regression against a running frontend with isolated, stubbed API responses.

Run: FORGE_UX_URL=http://127.0.0.1:5173 python scripts/check-ux-browser.py
Requires Playwright and Chromium; set FORGE_CHROMIUM_PATH for a nonstandard binary.
No real backend or model is contacted.
"""

import asyncio
import os
from urllib.parse import urlparse

from playwright.async_api import async_playwright

URL = os.environ.get("FORGE_UX_URL", "http://127.0.0.1:5173")


async def main():
    policy_fail = True
    cleanup_requests = 0
    model_writes = 0
    fail_runtime = False
    release_put = asyncio.Event()
    put_started = asyncio.Event()
    spaces = [
        {
            "id": 1,
            "name": "公共",
            "color": "gray",
            "isPublic": True,
            "description": "",
            "counts": dict.fromkeys(
                ["scenarios", "skills", "mcp", "plugins", "sessions"], 0
            ),
        },
        {
            "id": 2,
            "name": "研发",
            "color": "blue",
            "isPublic": False,
            "description": "",
            "counts": dict.fromkeys(
                ["scenarios", "skills", "mcp", "plugins", "sessions"], 0
            ),
        },
    ]
    tool = {
        "name": "read",
        "title": "读取",
        "icon": "file",
        "description": "读取文件",
        "permission": "read",
        "policyAllowed": True,
    }
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            executable_path=os.environ.get("FORGE_CHROMIUM_PATH") or None,
            args=["--no-sandbox"],
        )
        page = await browser.new_page(viewport={"width": 1280, "height": 900})
        page_errors = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))

        async def handle(route):
            nonlocal policy_fail, cleanup_requests, model_writes, fail_runtime
            req = route.request
            path = urlparse(req.url).path.removeprefix("/api")
            data = {
                "/auth/session": {
                    "authenticated": True,
                    "user": {
                        "id": "1",
                        "name": "管理员",
                        "username": "admin",
                        "role": "admin",
                        "workspace": "default",
                    },
                },
                "/agent-scenarios": [],
                "/agent/sessions": {"items": []},
                "/registry/tools": {"items": []},
                "/models/connection": {},
                "/runtime/status": {
                    "runner": {"status": "offline"},
                    "model": {"configured": False},
                    "limitations": [],
                },
                "/models/options": {"items": [], "defaultId": None},
                "/models": {"items": []},
                "/spaces": {"items": spaces},
                "/governance/policies": {
                    "allowedTools": ["read"],
                    "allowedPluginTools": ["*"],
                    "maxOutputTokens": 16384,
                    "requestTimeoutSeconds": 300,
                    "approvalTimeoutSeconds": 120,
                    "fileRetentionDays": 30,
                },
                "/governance/storage": {
                    "files": 1,
                    "bytes": 10,
                    "sessions": 1,
                    "storedObjects": 1,
                    "storedBytes": 10,
                    "retentionDays": 30,
                    "lastCleanup": None,
                },
                "/governance/web-search": None,
                "/governance/code-root": None,
                "/spaces/1/tools": {"items": [{**tool, "available": True}]},
                "/spaces/2/tools": {"items": [{**tool, "available": False}]},
                "/spaces/1/tools/read/usage": {"scenarios": []},
            }
            if path == "/models" and req.method == "POST":
                model_writes += 1
                fail_runtime = True
                await route.fulfill(json={"code": 0, "data": {}})
                return
            if path == "/runtime/status" and fail_runtime:
                await route.fulfill(status=500, json={"message": "模拟状态刷新失败"})
                return
            if path == "/governance/policies" and policy_fail:
                await route.fulfill(status=500, json={"message": "模拟读取失败"})
                return
            if path == "/governance/storage/cleanup":
                cleanup_requests += 1
            if path == "/spaces/1/tools/read" and req.method == "PUT":
                put_started.set()
                await release_put.wait()
                await route.fulfill(
                    json={"code": 0, "data": {"items": [{**tool, "available": False}]}}
                )
                return
            await route.fulfill(json={"code": 0, "data": data.get(path, {})})

        await page.route("**/api/**", handle)
        try:
            await page.goto(URL + "/agent/models", wait_until="domcontentloaded")
            try:
                await page.get_by_role(
                    "button", name="添加模型", exact=True
                ).first.click(timeout=30000)
            except Exception:
                print(
                    "BODY:",
                    (await page.locator("body").inner_text())[:2000],
                    "ERRORS:",
                    page_errors,
                )
                raise
            await page.get_by_placeholder("例如：企业 DeepSeek Chat").fill(
                "尚未保存的模型"
            )
            await page.locator(".model-editor-footer button").first.click()
            await page.get_by_text("模型配置有未保存的修改").wait_for()
            await page.get_by_role("button", name="继续编辑").click()
            assert (
                await page.get_by_placeholder("例如：企业 DeepSeek Chat").input_value()
                == "尚未保存的模型"
            )
            await page.locator('a[href="/agent/workbench"]').first.evaluate(
                "(link) => link.click()"
            )
            await page.get_by_text("模型配置有未保存的修改").wait_for()
            await page.get_by_role("button", name="继续编辑").click()
            assert page.url.endswith("/agent/models")
            await page.locator(".model-editor-footer button").first.click()
            await page.get_by_role("button", name="放弃修改").click()
            await page.get_by_placeholder("例如：企业 DeepSeek Chat").wait_for(
                state="hidden"
            )
            print("PASS model drawer and navigation protect unfinished edits")
            await page.get_by_role("button", name="添加模型", exact=True).first.click()
            await page.get_by_placeholder("例如：企业 DeepSeek Chat").fill("模型一")
            await page.get_by_placeholder("例如：deepseek-chat").fill("model-1")
            await page.get_by_placeholder("https://your-gateway.example.com/v1").fill(
                "https://example.com/v1"
            )
            await page.get_by_role("button", name="保存模型").click()
            await page.get_by_text("模型已保存，但状态刷新失败；请刷新页面").wait_for()
            assert model_writes == 1
            await page.get_by_placeholder("例如：企业 DeepSeek Chat").wait_for(
                state="hidden"
            )
            fail_runtime = False
            print(
                "PASS accepted model save is not reported as a failed write when refresh fails"
            )

            await page.goto(URL + "/agent/governance")
            try:
                await page.get_by_text("未能读取执行策略，暂不能保存").wait_for(
                    timeout=10000
                )
            except Exception:
                print(
                    "POLICY",
                    page.url,
                    (await page.locator("body").inner_text())[:3000],
                    page_errors,
                )
                raise
            assert await page.locator("form.governance-form").count() == 0
            policy_fail = False
            await page.locator(".ant-alert").first.locator("button").click(timeout=5000)
            await page.locator("form.governance-form").wait_for()
            print(
                "PASS failed policy read cannot expose defaults for saving; retry restores form"
            )
            await page.get_by_role("button", name="立即清理过期文件").click()
            await page.get_by_text("立即清理过期会话文件？").wait_for()
            await page.locator(".ant-modal-confirm-btns button").first.click()
            assert cleanup_requests == 0
            print("PASS cancelled destructive cleanup never reaches the API")

            await page.goto(URL + "/agent/spaces")
            switch = page.get_by_role("switch", name="在公共关闭读取")
            await switch.wait_for()
            await switch.click()
            await asyncio.wait_for(put_started.wait(), timeout=10)
            await page.locator(".space-admin-item").filter(has_text="研发").click()
            other = page.get_by_role("switch", name="在研发开启读取")
            await other.wait_for()
            release_put.set()
            await page.wait_for_timeout(500)
            assert await other.get_attribute("aria-checked") == "false"
            assert await page.get_by_role("switch", name="在研发关闭读取").count() == 0
            print("PASS late tool mutation cannot overwrite another space")
            assert not page_errors, page_errors
        finally:
            release_put.set()
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
