"""进行中回合的实时通道：只在本进程内存中转发，不落库。

Runner 把流式增量（正文 / 思考片段）标记为 transient：不写执行日志、没有序号。控制面与之一致，
片段不再逐条写库，只经这里推送给正在查看的页面；持久事件提交后也从这里按到达顺序推送，
保证「片段 → 回复结算」的先后不乱。页面中途打开时先读库补齐，再用快照取得尚未结算的正文与思考。

与 session_service.tasks 一样假定控制面是单进程；没有进行中的回合时，事件流回退为读库。
"""

import asyncio

# 与 Runner journal.ts 的 TRANSIENT_KINDS 一致：只转发，不落库、没有序号
# live_reset：模型请求失败后自动重试，丢弃上一次尝试尚未结算的正文与思考
TRANSIENT_KINDS = frozenset({"message_delta", "reasoning_delta", "live_reset"})
# 单个页面允许积压的事件数；读取跟不上时不再积压，改为重新读库并取快照
SUBSCRIBER_BUFFER = 2000
# 回合结束标记
END = None


class Subscription:
    """一个页面的订阅：订阅瞬间的快照（尚未结算的正文、思考，已推送到的序号）与待读事件。"""

    def __init__(self, turn: "LiveTurn"):
        self.turn = turn
        self.text = turn.text
        self.reasoning = turn.reasoning
        self.seq = turn.seq
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=SUBSCRIBER_BUFFER)
        # 积压已满、丢过事件：读取方应放弃本订阅，重新读库并取快照
        self.lagged = False

    def put(self, item):
        if self.lagged:
            return
        try:
            self.queue.put_nowait(item)
        except asyncio.QueueFull:
            self.lagged = True

    def drain(self) -> list:
        items = []
        while not self.queue.empty():
            items.append(self.queue.get_nowait())
        return items


class LiveTurn:
    def __init__(self, seq: int):
        self.text = ""
        self.reasoning = ""
        # 已提交并推送的最后一个持久事件序号
        self.seq = seq
        self.subscribers: set[Subscription] = set()


class LiveHub:
    def __init__(self):
        self.turns: dict[int, LiveTurn] = {}

    def begin(self, session_id: int, seq: int):
        """回合开始转发事件；seq 为此前已落库的最后一个序号。"""
        self.end(session_id)
        self.turns[session_id] = LiveTurn(seq)

    def delta(self, session_id: int, kind: str, text: str, source: str = "llm"):
        turn = self.turns.get(session_id)
        if turn is None:
            return
        if kind == "live_reset":
            turn.text = ""
            turn.reasoning = ""
            for subscriber in turn.subscribers:
                subscriber.put({"kind": kind, "source": source, "payload": {}})
            return
        if not text:
            return
        if kind == "message_delta":
            turn.text += text
        else:
            turn.reasoning += text
        event = {"kind": kind, "source": source, "payload": {"text": text}}
        for subscriber in turn.subscribers:
            subscriber.put(event)

    def publish(self, session_id: int, event: dict):
        """持久事件已提交：推进快照位置并推送。回复结算后，尚未结算的正文与思考清空。"""
        turn = self.turns.get(session_id)
        if turn is None:
            return
        turn.seq = max(turn.seq, event["seq"])
        if event["kind"] == "message":
            turn.text = ""
            turn.reasoning = ""
        for subscriber in turn.subscribers:
            subscriber.put(event)

    def end(self, session_id: int):
        turn = self.turns.pop(session_id, None)
        if turn is None:
            return
        for subscriber in turn.subscribers:
            subscriber.put(END)
        turn.subscribers.clear()

    def subscribe(self, session_id: int) -> Subscription | None:
        """订阅进行中的回合；没有进行中的回合时返回 None（调用方回退为读库）。"""
        turn = self.turns.get(session_id)
        if turn is None:
            return None
        subscription = Subscription(turn)
        turn.subscribers.add(subscription)
        return subscription

    def unsubscribe(self, subscription: Subscription):
        subscription.turn.subscribers.discard(subscription)


def coalesce(items: list) -> list:
    """合并相邻的同类片段：一次推送多个片段时只发一条，减少页面更新次数。"""
    merged: list = []
    for item in items:
        previous = merged[-1] if merged else None
        if (
            item is not END
            and item["kind"] in TRANSIENT_KINDS
            and previous is not END
            and previous is not None
            and previous["kind"] == item["kind"]
        ):
            merged[-1] = {
                **previous,
                "payload": {"text": previous["payload"]["text"] + item["payload"]["text"]},
            }
        else:
            merged.append(item)
    return merged


live_hub = LiveHub()
