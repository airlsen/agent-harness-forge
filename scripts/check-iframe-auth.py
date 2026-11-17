#!/usr/bin/env python3
"""双 HTTPS 测试域的原生跨站 iframe Cookie 验证。仅登录/退出真实已部署应用。

使用本机临时 TLS 证书和透明转发，避免 Playwright route.fulfill 对分区 Cookie
的人工处理影响结果；不验证 Arena 流量令牌或真实公网代理是否可达。
"""

import asyncio
import sys
import json
import ssl
import subprocess
import tempfile
import threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import httpx
from playwright.async_api import async_playwright, expect

BLOCK_COOKIES = "--block-cookies" in sys.argv
BLOCK_STORAGE = "--block-storage" in sys.argv
OPAQUE_FRAME = "--opaque-frame" in sys.argv
ROOT = Path(__file__).resolve().parents[1]
credentials = dict(
    line.split("=", 1)
    for line in (ROOT / "data/admin-login.txt").read_text().splitlines()
)


class Proxy(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.forward()

    def do_POST(self):
        self.forward()

    def do_PUT(self):
        self.forward()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header(
            "Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS"
        )
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, X-Forge-CSRF, X-Forge-Session, Last-Event-ID, Accept",
        )
        self.send_header("Content-Length", "0")
        self.end_headers()

    def forward(self):
        if self.headers["Host"].startswith("forge-parent.test"):
            sandbox = (
                ' sandbox="allow-scripts allow-forms allow-downloads"'
                if OPAQUE_FRAME
                else ""
            )
            raw = f'<iframe{sandbox} src="https://forge-child.test:{self.server.server_port}/agent/chat" width="1300" height="900"></iframe>'.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
        else:
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            headers = {
                key: value
                for key, value in self.headers.items()
                if key.lower() not in ("host", "content-length", "accept-encoding")
                and not (BLOCK_COOKIES and key.lower() == "cookie")
            }
            with httpx.Client(trust_env=False) as client:
                response = client.request(
                    self.command,
                    "http://127.0.0.1:5173" + self.path,
                    headers=headers,
                    content=body,
                )
            raw = response.content
            self.send_response(response.status_code)
            for key, value in response.headers.items():
                if key.lower() not in (
                    "content-length",
                    "content-encoding",
                    "transfer-encoding",
                    "connection",
                ) and not (BLOCK_COOKIES and key.lower() == "set-cookie"):
                    self.send_header(key, value)
        self.send_header("Content-Length", str(len(raw)))
        # 只在本机测试转发器模拟允许不透明源的预览代理；不放宽业务服务 CORS。
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(raw)


async def browser_test(port):
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--no-proxy-server",
                "--host-resolver-rules=MAP forge-parent.test 127.0.0.1, MAP forge-child.test 127.0.0.1",
            ],
        )
        context = await browser.new_context(
            ignore_https_errors=True, viewport={"width": 1440, "height": 1020}
        )
        try:
            if BLOCK_STORAGE:
                await context.add_init_script(
                    "Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('Storage blocked by test', 'SecurityError'); } });"
                )
            page = await context.new_page()
            await page.goto(f"https://forge-parent.test:{port}/")
            frame = page.frame_locator("iframe")
            await expect(frame.get_by_label("密码", exact=True)).to_be_visible()
            await frame.get_by_label("密码", exact=True).fill(credentials["password"])
            await frame.get_by_role("button", name="进入企业平台").click()
            await expect(frame.locator(".app-shell")).to_be_visible()
            attributes = [
                {
                    key: cookie.get(key)
                    for key in [
                        "name",
                        "secure",
                        "httpOnly",
                        "sameSite",
                        "partitionKey",
                    ]
                }
                for cookie in await context.cookies()
            ]
            if BLOCK_COOKIES:
                assert not attributes
                print(
                    "PASS cookie-stripping HTTPS iframe logs into actual workspace using a preview header"
                )
                await frame.get_by_role("link", name="平台管理", exact=True).click()
                await (
                    frame.locator(".enterprise-admin-tabs")
                    .get_by_role("link", name="模型连接", exact=True)
                    .click()
                )
                await expect(
                    frame.get_by_role("heading", name="模型连接", exact=True)
                ).to_be_visible()
                print("PASS model-center protected APIs work without any cookie")
                await frame.get_by_role("link", name="企业策略", exact=True).click()
                await frame.get_by_role("button", name="保存策略", exact=True).click()
                await expect(frame.get_by_role("alert")).to_contain_text("策略已保存")
                print("PASS actual CSRF-protected policy save works without cookies")
                if not BLOCK_STORAGE:
                    await page.reload()
                    await expect(frame.locator(".app-shell")).to_be_visible()
                    print(
                        "PASS cookie-free preview session survives a full iframe reload"
                    )
                else:
                    print(
                        "PASS cookie-free login works even when sessionStorage is unavailable (memory only)"
                    )
                await page.screenshot(
                    path=str(
                        ROOT
                        / "data/business-checks"
                        / (
                            "preview-memory-auth.png"
                            if BLOCK_STORAGE
                            else "preview-cookie-free-auth.png"
                        )
                    )
                )
            else:
                assert any(
                    cookie["partitionKey"] == "https://forge-parent.test"
                    and cookie["secure"]
                    and cookie["httpOnly"]
                    and cookie["sameSite"] == "None"
                    for cookie in attributes
                )
                print(
                    "PASS native cross-site HTTPS iframe login and partitioned HttpOnly Secure cookie"
                )
            await frame.get_by_role("button", name="退出登录", exact=True).click()
            await expect(frame.get_by_label("密码", exact=True)).to_be_visible()
            status = await frame.locator("body").evaluate(
                "async () => (await (await fetch('/api/auth/session')).json()).data"
            )
            assert not status["authenticated"]
            print(
                "PASS native cross-site HTTPS iframe logout"
                if not BLOCK_COOKIES
                else "PASS cookie-free iframe logout clears the preview session"
            )
            (
                ROOT
                / (
                    "data/business-checks/iframe-memory-report.json"
                    if BLOCK_STORAGE
                    else "data/business-checks/iframe-cookie-blocked-report.json"
                    if BLOCK_COOKIES
                    else "data/business-checks/iframe-report.json"
                )
            ).write_text(
                json.dumps(
                    {
                        "result": "passed",
                        "scope": "actual app over native local TLS proxy and two cross-site test domains; Arena traffic authentication not tested",
                        "cookieAttributes": attributes,
                        "checks": 5 if BLOCK_COOKIES else 2,
                        "cookiesBlocked": BLOCK_COOKIES,
                        "storageBlocked": BLOCK_STORAGE,
                        "opaqueFrame": OPAQUE_FRAME,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
        finally:
            await browser.close()


with tempfile.TemporaryDirectory(prefix="forge-tls-test-") as temporary:
    key, cert = Path(temporary) / "key.pem", Path(temporary) / "cert.pem"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(key),
            "-out",
            str(cert),
            "-days",
            "1",
            "-subj",
            "/CN=forge-child.test",
            "-addext",
            "subjectAltName=DNS:forge-child.test,DNS:forge-parent.test",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(cert, key)
    server.socket = tls.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        asyncio.run(browser_test(server.server_port))
    finally:
        server.shutdown()
        server.server_close()
