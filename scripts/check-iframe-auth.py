#!/usr/bin/env python3
"""双 HTTPS 测试域的原生跨站 iframe Cookie 验证。仅登录/退出真实已部署应用。

使用本机临时 TLS 证书和透明转发，避免 Playwright route.fulfill 对分区 Cookie
的人工处理影响结果；不验证 Arena 流量令牌或真实公网代理是否可达。
"""

import asyncio
import json
import ssl
import subprocess
import tempfile
import threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import httpx
from playwright.async_api import async_playwright, expect

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

    def forward(self):
        if self.headers["Host"].startswith("forge-parent.test"):
            raw = f'<iframe src="https://forge-child.test:{self.server.server_port}/agent/chat" width="1300" height="900"></iframe>'.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
        else:
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            headers = {
                key: value
                for key, value in self.headers.items()
                if key.lower() not in ("host", "content-length", "accept-encoding")
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
                ):
                    self.send_header(key, value)
        self.send_header("Content-Length", str(len(raw)))
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
            page = await context.new_page()
            await page.goto(f"https://forge-parent.test:{port}/")
            frame = page.frame_locator("iframe")
            await expect(frame.get_by_label("密码", exact=True)).to_be_visible()
            await frame.get_by_label("密码", exact=True).fill(credentials["password"])
            await frame.get_by_role("button", name="进入工作空间").click()
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
            assert any(
                cookie["partitionKey"] == "https://forge-parent.test"
                and cookie["secure"]
                and cookie["httpOnly"]
                and cookie["sameSite"] == "None"
                for cookie in attributes
            ), attributes
            print(
                "PASS native cross-site HTTPS iframe login and partitioned HttpOnly Secure cookie"
            )
            await frame.get_by_role("button", name="退出登录", exact=True).click()
            await expect(frame.get_by_label("密码", exact=True)).to_be_visible()
            status = await frame.locator("body").evaluate(
                "async () => (await (await fetch('/api/auth/session')).json()).data"
            )
            assert not status["authenticated"]
            print("PASS native cross-site HTTPS iframe logout")
            (ROOT / "data/business-checks/iframe-report.json").write_text(
                json.dumps(
                    {
                        "result": "passed",
                        "scope": "actual app over native local TLS proxy and two cross-site test domains; Arena traffic authentication not tested",
                        "cookieAttributes": attributes,
                        "checks": 2,
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
