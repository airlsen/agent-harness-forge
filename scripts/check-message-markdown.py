#!/usr/bin/env python3
"""Check chat Markdown and the Mermaid full-viewer using stubbed APIs.

Start a frontend dev server and install Playwright/Chromium. FORGE_FRONTEND_URL
and FORGE_BROWSER_PATH may override their defaults; no real backend is used.
"""

import json
import os
import runpy
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

fixtures = runpy.run_path(
    str(Path(__file__).with_name("check-human-message-layout.py"))
)
responses = dict(fixtures["responses"])
text = """前文

---

后文

> **审查结论摘录**
>
> 高危项集中在认证与数据访问层，需在 24 小时内处置。
>
> > 嵌套引用：子结论——`app/auth.py:42` 存在硬编码密钥。
>
> —— 安全评审小组

<blockquote>
<p><strong>审查结论摘录</strong></p>
<p>高危项需在 24 小时内处置。</p>
<blockquote><p>嵌套引用：<code>app/auth.py:42</code></p></blockquote>
<p>—— 安全评审小组</p>
</blockquote>

```mermaid
flowchart LR
 A[用户] --> B[服务] --> C[数据库]
```

```mermaid
not a diagram
```
"""
responses["/api/agent/sessions/42"] = {
    **responses["/api/agent/sessions/42"],
    "messages": [
        {"id": 1, "role": "user", "content": "查看图表", "meta": {}},
        {"id": 2, "role": "assistant", "content": text, "meta": {}},
    ],
}
responses["/api/skills/1/authoring-session/latest"] = {
    "id": 1,
    "messages": [{"id": 1, "role": "assistant", "content": text}],
}
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
                page.set_viewport_size({"width": width, "height": 800})
                page.goto(URL + "/agent/chat/42")
                page.evaluate(
                    "theme => localStorage.setItem('forge-theme', theme)", theme
                )
                page.reload()
                markdown = page.locator(".step-text .markdown-body")
                expect(markdown.locator("hr")).to_have_count(1)
                rule = markdown.locator("hr").evaluate(
                    "e => ({height: e.getBoundingClientRect().height, border:getComputedStyle(e).borderTopWidth})"
                )
                assert rule == {"height": 16, "border": "0px"}, rule
                # The shared Markdown renderer also powers file previews: leave those untouched.
                assert page.evaluate("""() => {
                    const preview = document.createElement('div');
                    preview.className = 'markdown-body';
                    preview.innerHTML = '<hr><blockquote>preview</blockquote>';
                    document.body.append(preview);
                    const hr = getComputedStyle(preview.querySelector('hr'));
                    const quote = getComputedStyle(preview.querySelector('blockquote'));
                    const unchanged = hr.borderTopWidth !== '0px' && quote.borderLeftColor !== getComputedStyle(document.querySelector('.step-text blockquote')).borderLeftColor;
                    preview.remove(); return unchanged;
                }""")
                quotes = markdown.locator("blockquote")
                expect(quotes).to_have_count(4)
                colors = quotes.evaluate_all(
                    "es => es.map(e => [getComputedStyle(e).borderLeftColor, getComputedStyle(e).getPropertyValue('--color-brand')])"
                )
                # Resolve the token to a computed color, including CSS variable indirection.
                for quote in quotes.all():
                    assert quote.evaluate("""e => {
                        const probe = document.createElement('i');
                        probe.style.color = 'var(--color-brand)'; e.append(probe);
                        const match = getComputedStyle(e).borderLeftColor === getComputedStyle(probe).color;
                        probe.remove(); return match;
                    }"""), colors
                diagrams = markdown.locator(".diagram-block")
                expect(diagrams).to_have_count(2)
                valid = diagrams.first
                expect(valid.locator(".diagram-body svg")).to_have_count(
                    1, timeout=30000
                )
                expect(diagrams.nth(1).locator(".diagram-error")).to_be_visible(
                    timeout=30000
                )
                expect(
                    diagrams.nth(1).get_by_role("button", name="查看全图")
                ).to_have_count(0)
                open_button = valid.get_by_role("button", name="查看全图")
                open_button.click()
                dialog = page.get_by_role("dialog", name="Mermaid 图全图")
                expect(dialog).to_be_visible()
                expect(dialog.locator(".mermaid-viewer-graphic svg")).to_have_count(1)
                assert page.locator("svg[id^=mmd-]").count() == 1
                metrics = dialog.locator(".mermaid-viewer-canvas").evaluate("""e => {
                    const r = e.getBoundingClientRect(), g = e.querySelector('.mermaid-viewer-graphic').getBoundingClientRect();
                    return {w:r.width,h:r.height,gw:g.width,gh:g.height, bg:getComputedStyle(e).backgroundColor};
                }""")
                assert (
                    0 < metrics["gw"] <= metrics["w"]
                    and 0 < metrics["gh"] <= metrics["h"]
                ), metrics
                assert metrics["bg"] == "rgb(255, 255, 255)", metrics
                for _ in range(12):
                    dialog.get_by_role("button", name="放大图形").click()
                expect(
                    dialog.get_by_role("button", name="400%", exact=True)
                ).to_be_visible()
                assert dialog.locator(".mermaid-viewer-canvas").evaluate("""e => {
                    e.scrollLeft = e.scrollWidth; e.scrollTop = e.scrollHeight;
                    return (e.scrollWidth > e.clientWidth && e.scrollLeft > 0) ||
                           (e.scrollHeight > e.clientHeight && e.scrollTop > 0);
                }""")
                dialog.get_by_role("button", name="400%", exact=True).click()
                expect(
                    dialog.get_by_role("button", name="100%", exact=True)
                ).to_be_visible()
                page.keyboard.press("Escape")
                expect(dialog).to_have_count(0)
                expect(open_button).to_be_focused()
                expect(valid.locator(".diagram-body svg")).to_have_count(1)
                valid.get_by_role("button", name="查看源码").click()
                expect(valid.get_by_role("button", name="查看图形")).to_be_visible()
                open_button.click()
                expect(dialog).to_be_visible()
                dialog.get_by_role("button", name="关闭全图").click()
                expect(valid.get_by_role("button", name="查看图形")).to_be_visible()
                expect(
                    valid.get_by_role("button", name="复制", exact=True)
                ).to_be_visible()
                page.goto(URL + "/agent/skills/1")
                if width <= 900:
                    page.get_by_role("button", name="对话", exact=True).click()
                skill_markdown = page.locator(
                    ".studio-chat .chat-message.assistant .markdown-body"
                )
                expect(skill_markdown.locator("hr")).to_have_css(
                    "border-top-width", "0px"
                )
                expect(skill_markdown.locator("blockquote")).to_have_count(4)
                assert skill_markdown.locator("blockquote").first.evaluate("""e => {
                    const probe = document.createElement('i');
                    probe.style.color = 'var(--color-brand)'; e.append(probe);
                    const match = getComputedStyle(e).borderLeftColor === getComputedStyle(probe).color;
                    probe.remove(); return match;
                }""")
                skill_view = skill_markdown.locator(".diagram-block").first.get_by_role(
                    "button", name="查看全图"
                )
                expect(skill_view).to_be_visible(timeout=30000)
                skill_view.click()
                expect(
                    page.get_by_role("dialog", name="Mermaid 图全图")
                ).to_be_visible()
                page.keyboard.press("Escape")
                expect(skill_view).to_be_focused()
                print(f"OK: {theme}, {width}px, chat and Skill")
        browser.close()


if __name__ == "__main__":
    main()
