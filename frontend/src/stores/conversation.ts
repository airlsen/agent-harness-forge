import { defineStore } from 'pinia';
import { api, post } from '../api/client';
import { openEventStream } from '../api/events';
import { usePlatform } from './platform';
import type { Approval, ChatMessage, KernelEvent, SessionDetail } from '../types/platform';
let stream: { close: () => void } | null = null;
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
    draftRevision: 0,
    liveText: '',
    sending: false,
    loading: false,
    runError: '',
    connectionWarning: '',
    panel: 'files' as 'context' | 'trajectory' | 'files',
    panelOpen: false,
  }),
  getters: { running: (state) => state.sending || state.current?.status === 'running' },
  actions: {
    disconnect() {
      stream?.close();
      stream = null;
    },
    newConversation(scenarioId?: number) {
      ++openGeneration;
      ++this.draftRevision;
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
      this.input = '';
      this.draftAttachments = [];
      this.panelOpen = false;
      this.panel = 'files';
      this.selectedScenarioId = scenarioId ?? usePlatform().availableScenarios[0]?.id ?? null;
    },
    async open(id: number) {
      const generation = ++openGeneration;
      ++this.draftRevision;
      this.disconnect();
      this.input = '';
      this.draftAttachments = [];
      this.sending = false;
      this.loading = true;
      this.liveText = '';
      this.runError = '';
      this.connectionWarning = '';
      this.files = [];
      this.current = null;
      this.messages = [];
      this.events = [];
      this.approvals = [];
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
      if (!platform.connection?.configured) throw new Error('模型尚未连接，请由管理员在「模型连接」完成配置');
      const scenarioId =
        platform.scenarios.find((scenario) => scenario.id === this.selectedScenarioId)?.id ??
        platform.availableScenarios[0]?.id;
      if (!scenarioId) throw new Error('请先选择一个场景');
      const message = [
        this.input.trim(),
        ...this.draftAttachments.map((file) => `\n附件：${file.name}\n\`\`\`text\n${file.content}\n\`\`\``),
      ].join('\n');
      if (message.length > 64000) throw new Error('任务与文本附件合计不能超过 64000 字符');
      const generation = openGeneration;
      this.sending = true;
      this.runError = '';
      this.connectionWarning = '';
      this.liveText = '';
      try {
        const session = this.current ?? (await post<SessionDetail>('/agent/sessions', { scenarioId }));
        // A navigation/new draft during an in-flight create must never attach its receipt
        // or text to another conversation. Backend execution, once accepted, continues.
        if (generation !== openGeneration) {
          await platform.refreshSessions();
          return null;
        }
        this.current = session;
        const receipt = await post(`/agent/sessions/${session.id}/turns`, { message });
        if (generation !== openGeneration) {
          await platform.refreshSessions();
          return null;
        }
        this.messages.push({ id: receipt.messageId, role: 'user', content: message, meta: {} });
        this.input = '';
        this.draftAttachments = [];
        this.current.status = 'running';
        this.follow(session.id, receipt.cursor);
        await platform.refreshSessions();
        return generation === openGeneration ? session.id : null;
      } finally {
        if (generation === openGeneration) this.sending = false;
      }
    },
    follow(id: number, after: number) {
      this.disconnect();
      this.connectionWarning = '';
      stream = openEventStream(`/api/agent/sessions/${id}/events?after=${after}`, {
        kernel: (event) => {
          if (this.current?.id !== id) return;
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
        },
        settled: () => {
          if (this.current?.id === id) {
            this.disconnect();
            void this.settled(id);
          }
        },
        open: () => {
          if (this.current?.id === id) this.connectionWarning = '';
        },
        error: () => {
          if (this.current?.id === id && this.current.status === 'running')
            this.connectionWarning = '实时连接中断，正在重连；后台执行和日志持久化仍在继续。';
        },
      });
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
