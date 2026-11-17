import { defineStore } from 'pinia';
import { api, post } from '../api/client';
import { usePlatform } from './platform';
import type { Approval, ChatMessage, KernelEvent, SessionDetail } from '../types/platform';
let stream: EventSource | null = null;
let openGeneration = 0;

async function trajectory(id: number, last: number) {
  const events: KernelEvent[] = [];
  let cursor = 0;
  while (true) {
    const page = await api<{ events: KernelEvent[]; nextCursor: number }>(
      `/agent/sessions/${id}/trajectory?cursor=${cursor}`,
    );
    events.push(...page.events);
    if (!page.events.length || page.nextCursor >= last) break;
    cursor = page.nextCursor;
  }
  return events;
}
export const useConversation = defineStore('conversation', {
  state: () => ({
    current: null as SessionDetail | null,
    messages: [] as ChatMessage[],
    events: [] as KernelEvent[],
    approvals: [] as Approval[],
    files: [] as { path: string; bytes: number }[],
    selectedScenarioId: null as number | null,
    input: '',
    draftAttachments: [] as { name: string; content: string }[],
    liveText: '',
    sending: false,
    loading: false,
    runError: '',
    connectionWarning: '',
    panel: 'context' as 'context' | 'trajectory' | 'files',
    panelOpen: window.innerWidth >= 1280,
  }),
  getters: { running: (state) => state.sending || state.current?.status === 'running' },
  actions: {
    disconnect() {
      stream?.close();
      stream = null;
    },
    newConversation(scenarioId?: number) {
      ++openGeneration;
      this.disconnect();
      this.current = null;
      this.messages = [];
      this.events = [];
      this.approvals = [];
      this.files = [];
      this.liveText = '';
      this.runError = '';
      this.connectionWarning = '';
      this.sending = false;
      this.loading = false;
      if (scenarioId) this.selectedScenarioId = scenarioId;
    },
    async open(id: number) {
      const generation = ++openGeneration;
      this.disconnect();
      this.loading = true;
      this.liveText = '';
      this.runError = '';
      this.connectionWarning = '';
      this.files = [];
      try {
        const detail = await api<SessionDetail>(`/agent/sessions/${id}`);
        const events = await trajectory(id, detail.lastEventSeq);
        if (generation !== openGeneration) return;
        this.current = detail;
        this.messages = detail.messages;
        this.selectedScenarioId = detail.scenarioId;
        this.approvals = detail.pendingApprovals;
        this.events = events;
        const lastError = [...events].reverse().find((event) => event.kind === 'error');
        if (['error', 'interrupted'].includes(detail.status))
          this.runError = lastError?.payload.message ?? '上一次任务未完成';
        void this.refreshFiles();
        if (detail.status === 'running') {
          for (const event of events) {
            if (event.kind === 'message_delta') this.liveText += event.payload.text;
            else if (event.kind === 'message') this.liveText = '';
          }
          // detail 的消息快照与事件读取可能有时间差；结算时统一回读数据库去重。
          this.follow(id, events.at(-1)?.seq ?? 0);
        }
      } finally {
        if (generation === openGeneration) this.loading = false;
      }
    },
    async submit(): Promise<number | null> {
      const platform = usePlatform();
      if (this.running || (!this.input.trim() && !this.draftAttachments.length)) return null;
      if (!platform.connection?.configured) throw new Error('模型未配置，请先到模型中心保存真实模型连接');
      const scenarioId =
        platform.scenarios.find((scenario) => scenario.id === this.selectedScenarioId)?.id ??
        platform.scenarios[0]?.id;
      if (!scenarioId) throw new Error('请先选择一个场景');
      const message = [
        this.input.trim(),
        ...this.draftAttachments.map((file) => `\n附件：${file.name}\n\`\`\`text\n${file.content}\n\`\`\``),
      ].join('\n');
      if (message.length > 64000) throw new Error('任务与文本附件合计不能超过 64000 字符');
      this.sending = true;
      this.runError = '';
      this.connectionWarning = '';
      this.liveText = '';
      try {
        if (!this.current) this.current = await post<SessionDetail>('/agent/sessions', { scenarioId });
        const receipt = await post(`/agent/sessions/${this.current.id}/turns`, { message });
        this.messages.push({ id: receipt.messageId, role: 'user', content: message, meta: {} });
        this.input = '';
        this.draftAttachments = [];
        this.current.status = 'running';
        this.follow(this.current.id, receipt.cursor);
        await platform.refreshSessions();
        return this.current.id;
      } finally {
        this.sending = false;
      }
    },
    follow(id: number, after: number) {
      this.disconnect();
      this.connectionWarning = '';
      stream = new EventSource(`/api/agent/sessions/${id}/events?after=${after}`);
      stream.addEventListener('kernel', (value) => {
        if (this.current?.id !== id) return;
        const event: KernelEvent = JSON.parse((value as MessageEvent).data);
        if (this.events.some((row) => row.seq === event.seq)) return;
        this.events.push(event);
        const data = event.payload;
        if (event.kind === 'message_delta') this.liveText += data.text;
        else if (event.kind === 'message') {
          if (
            !this.messages.some(
              (message) =>
                message.id === data.runtimeMessageId ||
                message.meta.runtimeMessageId === data.runtimeMessageId,
            )
          )
            this.messages.push({
              id: data.runtimeMessageId ?? `live-${event.seq}`,
              role: 'assistant',
              content: data.text,
              meta: { partial: data.partial, runtimeMessageId: data.runtimeMessageId },
            });
          this.liveText = '';
        } else if (event.kind === 'tool_result') {
          if (
            !this.messages.some(
              (message) => message.role === 'tool' && message.meta.toolCallId === data.toolCallId,
            )
          )
            this.messages.push({ id: `tool-${event.seq}`, role: 'tool', content: data.result, meta: data });
        } else if (event.kind === 'approval_required') this.approvals.push(data);
        else if (event.kind === 'approval_resolved')
          this.approvals = this.approvals.filter((approval) => approval.ticketId !== data.ticketId);
        else if (event.kind === 'error') this.runError = data.message;
        else if (event.kind === 'cost_tick') {
          this.current.tokensIn = data.totalTokensIn;
          this.current.tokensOut = data.totalTokensOut;
          this.current.cost = data.cost;
        } else if (event.kind === 'files') {
          this.panel = 'files';
          void this.refreshFiles();
        }
      });
      stream.addEventListener('settled', () => {
        if (this.current?.id === id) {
          this.disconnect();
          void this.settled(id);
        }
      });
      stream.onopen = () => {
        if (this.current?.id === id) this.connectionWarning = '';
      };
      stream.onerror = () => {
        if (this.current?.id === id && this.current.status === 'running')
          this.connectionWarning = '实时连接中断，正在重连；后台执行和日志持久化仍在继续。';
      };
    },
    async settled(id: number) {
      try {
        const detail = await api<SessionDetail>(`/agent/sessions/${id}`);
        if (this.current?.id !== id) return;
        this.current = detail;
        this.messages = detail.messages;
        this.approvals = detail.pendingApprovals;
        this.liveText = '';
        await usePlatform().refreshSessions();
        await this.refreshFiles();
      } catch (error) {
        usePlatform().toast((error as Error).message, 'error');
      }
    },
    async refreshFiles() {
      const id = this.current?.id;
      if (!id) return;
      try {
        const result = await api<{ items: { path: string; bytes: number }[] }>(`/agent/sessions/${id}/files`);
        if (this.current?.id === id) this.files = result.items;
      } catch {
        if (this.current?.id === id) this.files = [];
      }
    },
    async interrupt() {
      if (this.current) await post(`/agent/sessions/${this.current.id}/interrupt`);
    },
    async resolveApproval(ticketId: number, action: 'approve' | 'deny') {
      try {
        await post(`/agent/approvals/${ticketId}/resolve`, { action });
        this.approvals = this.approvals.filter((approval) => approval.ticketId !== ticketId);
      } catch (error) {
        if (this.current) void this.open(this.current.id);
        throw error;
      }
    },
  },
});
