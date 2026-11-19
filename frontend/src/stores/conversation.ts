import { defineStore } from 'pinia';
import { api, post, put, remove } from '../api/client';
import { openEventStream } from '../api/events';
import { usePlatform } from './platform';
import { fileUrl, type FileRetention, type WorkspaceFile } from '../utils/files';
import type {
  Approval,
  ChatMessage,
  CodeProjectList,
  KernelEvent,
  SessionDetail,
  SessionModelSegment,
} from '../types/platform';
let stream: { close: () => void } | null = null;
let openGeneration = 0;
// Reopening a conversation while its turn request is still in flight must read
// the database after that request settles, not display an older idle snapshot.
const pendingTurns = new Map<number, Promise<{ messageId: number; cursor: number }>>();
// A failed first turn can retry its created session, but that session must not
// become the visible conversation (or steal the start draft) before acceptance.
const preparedSessions = new Map<number, SessionDetail>();

interface TaskDraft {
  id: number;
  input: string;
  attachments: { name: string; content: string }[];
  scenarioId: number | null;
  /** 新会话所选模型；已有会话中为「从下一条消息起使用」的模型（与当前模型不同即待切换） */
  modelId: number | null;
  preview: boolean;
  /** 新会话的关联代码；已有会话的关联代码保存在服务端（修改即保存），不进入草稿 */
  codeProjects: string[];
}
/** 一个会话最多关联的代码项目数，与后端、Runner 一致 */
export const MAX_CODE_PROJECTS = 20;
// 「上次使用的模型」是按账号区分的偏好（不是草稿内容），保存在本机；读写失败时静默回退到平台默认。
const LAST_MODEL_KEY = 'forge.last-model.v1';
function readLastModel(username?: string): number | null {
  if (!username || typeof localStorage === 'undefined') return null;
  try {
    const value = (JSON.parse(localStorage.getItem(LAST_MODEL_KEY) ?? '{}') as Record<string, unknown>)[
      username
    ];
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}
function rememberLastModel(username: string | undefined, id: number | null) {
  if (!username || id === null || typeof localStorage === 'undefined') return;
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_MODEL_KEY) ?? '{}');
    const map = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    localStorage.setItem(LAST_MODEL_KEY, JSON.stringify({ ...map, [username]: id }));
  } catch {
    // 存储不可用（隐私模式、配额已满）不影响发送。
  }
}
interface TurnReceipt {
  messageId: number;
  cursor: number;
  messageMeta?: Record<string, any>;
  model?: SessionModelSegment;
  codeProjects?: string[];
}
function sameDraft(left: TaskDraft, right: TaskDraft) {
  return (
    left.id === right.id &&
    left.scenarioId === right.scenarioId &&
    left.modelId === right.modelId &&
    left.preview === right.preview &&
    left.input === right.input &&
    JSON.stringify(left.attachments) === JSON.stringify(right.attachments) &&
    JSON.stringify(left.codeProjects) === JSON.stringify(right.codeProjects)
  );
}

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
    files: [] as WorkspaceFile[],
    fileRetention: null as FileRetention | null,
    /** 文件清单已从服务端读取过（用于区分「加载中」与「文件已被删除」） */
    filesLoaded: false,
    selectedScenarioId: null as number | null,
    previewScenarioId: null as number | null,
    selectedModelId: null as number | null,
    input: '',
    draftAttachments: [] as { name: string; content: string }[],
    /** 新会话（尚未创建）选择的关联代码，随第一条消息提交 */
    draftCodeProjects: [] as string[],
    /** 代码根目录下的项目列表（打开选择器时刷新） */
    codeProjectList: null as CodeProjectList | null,
    codeSaving: false,
    draftRevision: 0,
    // Memory only, scoped to this authenticated tab. Never persist business drafts in Web Storage.
    drafts: {} as Record<string, TaskDraft>,
    draftKey: 'new',
    draftId: 0,
    draftSequence: 0,
    pendingNewConversation: null as null | { scenarioId?: number; draftId: number },
    liveText: '',
    liveReasoning: '',
    sending: false,
    loading: false,
    runError: '',
    connectionWarning: '',
    panel: 'files' as 'context' | 'trajectory' | 'files',
    panelOpen: false,
  }),
  getters: {
    running: (state) => state.sending || state.current?.status === 'running',
    /** 当前生效（已有会话）或待提交（新会话）的关联代码 */
    codeProjects: (state): string[] =>
      state.current ? (state.current.codeProjects ?? []) : state.draftCodeProjects,
    hasUnsentDrafts: (state) =>
      Boolean(
        state.input.trim() ||
        state.draftAttachments.length ||
        Object.entries(state.drafts).some(
          ([key, draft]) =>
            (key !== state.draftKey || state.loading || (key !== 'new' && !state.current)) &&
            (draft.input.trim() || draft.attachments.length),
        ),
      ),
  },
  actions: {
    disconnect() {
      stream?.close();
      stream = null;
    },
    snapshotDraft(): TaskDraft {
      if (!this.draftId) this.draftId = ++this.draftSequence;
      return {
        id: this.draftId,
        input: this.input,
        attachments: this.draftAttachments.map((file) => ({ ...file })),
        scenarioId: this.selectedScenarioId,
        modelId: this.selectedModelId,
        preview: this.selectedScenarioId !== null && this.selectedScenarioId === this.previewScenarioId,
        codeProjects: this.current ? [] : [...this.draftCodeProjects],
      };
    },
    saveDraft() {
      // An opening session has not restored its cached draft yet. Do not overwrite it.
      if (this.loading || (this.draftKey !== 'new' && !this.current)) return;
      const draft = this.snapshotDraft();
      // 已有会话里只选了待切换模型、尚未输入内容，同样保留这份选择。
      const pendingModel = Boolean(this.current && draft.modelId !== this.current.modelId);
      if (draft.input || draft.attachments.length || pendingModel || this.draftKey === 'new')
        this.drafts[this.draftKey] = draft;
      else delete this.drafts[this.draftKey];
    },
    resetSession(): number {
      ++openGeneration;
      ++this.draftRevision;
      this.disconnect();
      this.current = null;
      this.messages = [];
      this.events = [];
      this.approvals = [];
      this.files = [];
      this.fileRetention = null;
      this.filesLoaded = false;
      this.liveText = '';
      this.liveReasoning = '';
      this.runError = '';
      this.connectionWarning = '';
      this.sending = false;
      this.loading = false;
      this.input = '';
      this.draftAttachments = [];
      this.draftCodeProjects = [];
      this.panelOpen = false;
      this.panel = 'files';
      return openGeneration;
    },
    restoreDraft(key: string, scenarioId?: number, allowPreview = false) {
      const draft = this.drafts[key];
      this.draftKey = key;
      this.draftId = draft?.id ?? ++this.draftSequence;
      this.input = draft?.input ?? '';
      this.draftAttachments = draft?.attachments.map((file) => ({ ...file })) ?? [];
      this.draftCodeProjects = this.current ? [] : [...(draft?.codeProjects ?? [])];
      const platform = usePlatform();
      const selectedId = scenarioId ?? draft?.scenarioId;
      const selected = platform.scenarios.find(
        (scenario) =>
          scenario.id === selectedId &&
          (allowPreview ||
            draft?.preview ||
            platform.availableScenarios.some((item) => item.id === scenario.id)),
      );
      this.selectedScenarioId = selected?.id ?? platform.availableScenarios[0]?.id ?? null;
      this.previewScenarioId = selected?.status === 'draft' ? selected.id : null;
      this.selectedModelId = this.current
        ? this.sessionModel(draft?.modelId)
        : this.availableModel(draft?.modelId);
    },
    /** 已有会话：待切换的模型仍可用则保留，否则回到会话当前模型（即不切换）。 */
    sessionModel(id?: number | null): number | null {
      const current = this.current?.modelId ?? null;
      return id != null && id !== current && usePlatform().modelOptions.some((option) => option.id === id)
        ? id
        : current;
    },
    /** 所选模型仍可用则保留，否则依次回退到本人上次使用的模型、平台默认模型。 */
    availableModel(id?: number | null): number | null {
      const platform = usePlatform();
      const usable = (value: number | null | undefined): value is number =>
        value != null && platform.modelOptions.some((option) => option.id === value);
      if (usable(id)) return id;
      const last = readLastModel(platform.user?.username);
      if (usable(last)) return last;
      return platform.defaultModelId ?? platform.modelOptions[0]?.id ?? null;
    },
    prepareStart() {
      // Returning home parks this session's reply, not its execution. A new-task draft
      // is independent of every existing conversation and never inherits their context.
      if (this.current || this.loading || this.draftKey !== 'new') {
        this.saveDraft();
        this.resetSession();
        this.restoreDraft('new');
      } else {
        const platform = usePlatform();
        if (
          !platform.scenarios.some(
            (scenario) =>
              scenario.id === this.selectedScenarioId &&
              (platform.availableScenarios.some((item) => item.id === scenario.id) ||
                scenario.id === this.previewScenarioId),
          )
        ) {
          this.selectedScenarioId = platform.availableScenarios[0]?.id ?? null;
          this.previewScenarioId = null;
        }
        // 模型可能在模型管理中被停用或删除：回到工作台时重新校验。
        this.selectedModelId = this.availableModel(this.selectedModelId);
        if (!this.draftId) this.draftId = ++this.draftSequence;
      }
    },
    newConversation(scenarioId?: number) {
      this.saveDraft();
      this.resetSession();
      const discarded = this.drafts.new;
      if (discarded) preparedSessions.delete(discarded.id);
      delete this.drafts.new;
      this.restoreDraft('new', scenarioId, true);
      this.pendingNewConversation = null;
    },
    requestNewConversation(scenarioId?: number): boolean {
      this.saveDraft();
      const draft = this.drafts.new;
      if (draft && (draft.input.trim() || draft.attachments.length)) {
        this.pendingNewConversation = { scenarioId, draftId: draft.id };
        return false;
      }
      this.newConversation(scenarioId);
      return true;
    },
    clear() {
      this.resetSession();
      pendingTurns.clear();
      preparedSessions.clear();
      this.drafts = {};
      this.draftKey = 'new';
      this.draftId = ++this.draftSequence;
      this.selectedScenarioId = null;
      this.previewScenarioId = null;
      this.selectedModelId = null;
      this.pendingNewConversation = null;
    },
    /** 可选模型变化（首次加载、模型管理中停用/删除）后校正新会话草稿的模型。 */
    syncModel() {
      this.selectedModelId = this.current
        ? this.sessionModel(this.selectedModelId)
        : this.availableModel(this.selectedModelId);
    },
    /**
     * 新会话：选择创建时使用的模型。已有会话：选择从下一条消息起使用的模型，
     * 选回当前模型即取消切换；执行中不能切换（模型只在两轮之间变化）。
     */
    selectModel(id: number | null): boolean {
      if (this.running || this.loading) return false;
      const keepCurrent = Boolean(this.current) && id === (this.current?.modelId ?? null);
      if (!keepCurrent && (id === null || !usePlatform().modelOptions.some((option) => option.id === id)))
        return false;
      this.selectedModelId = id;
      return true;
    },
    selectScenario(id: number): boolean {
      if (
        this.current ||
        this.running ||
        this.loading ||
        !usePlatform().availableScenarios.some((scenario) => scenario.id === id)
      )
        return false;
      this.selectedScenarioId = id;
      this.previewScenarioId = null;
      return true;
    },
    consumeDraft(key: string, submitted: TaskDraft) {
      preparedSessions.delete(submitted.id);
      const cached = this.drafts[key];
      if (this.pendingNewConversation?.draftId === submitted.id && cached && sameDraft(cached, submitted))
        this.pendingNewConversation = null;
      if (cached && sameDraft(cached, submitted)) delete this.drafts[key];
      if (this.draftKey === key && sameDraft(this.snapshotDraft(), submitted)) {
        this.input = '';
        this.draftAttachments = [];
        ++this.draftRevision;
      }
    },
    async open(id: number) {
      this.saveDraft();
      const generation = this.resetSession();
      this.draftKey = `session:${id}`;
      this.draftId = ++this.draftSequence;
      this.loading = true;
      try {
        await pendingTurns.get(id)?.catch(() => {});
        if (generation !== openGeneration) return;
        const detail = await api<SessionDetail>(`/agent/sessions/${id}`);
        const events = await trajectory(id, detail.lastEventSeq);
        if (generation !== openGeneration) return;
        this.current = detail;
        this.messages = detail.messages;
        this.restoreDraft(`session:${id}`, detail.scenarioId, true);
        this.approvals = detail.pendingApprovals;
        this.events = events;
        const lastError = [...events].reverse().find((event) => event.kind === 'error');
        if (['error', 'interrupted'].includes(detail.status))
          this.runError = lastError?.payload.message ?? '上一次任务未完成';
        void this.refreshFiles();
        if (detail.status === 'running') {
          for (const event of events) {
            if (event.kind === 'message_delta') this.liveText += event.payload.text;
            else if (event.kind === 'reasoning_delta') this.liveReasoning += event.payload.text;
            else if (event.kind === 'message') {
              this.liveText = '';
              this.liveReasoning = '';
            }
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
      if (this.running || this.loading || (!this.input.trim() && !this.draftAttachments.length)) return null;
      // 已有会话使用冻结的模型分段继续，不依赖平台当前是否还有启用的模型。
      if (!this.current && !platform.connection?.configured)
        throw new Error('模型尚未连接，请由管理员在「模型连接」完成配置');
      const scenarioId =
        this.current?.scenarioId ??
        platform.scenarios.find((scenario) => scenario.id === this.selectedScenarioId)?.id ??
        platform.availableScenarios[0]?.id;
      if (!scenarioId) throw new Error('请先选择一个场景');
      // 新会话：所选模型失效时回退到推荐模型，而不是静默交给后端兜底。
      // 已有会话：只有选了不同且可用的模型才随本轮提交切换，否则沿用会话当前模型。
      const switchTo = this.current ? this.sessionModel(this.selectedModelId) : null;
      const turnModelId = this.current && switchTo !== this.current.modelId ? switchTo : null;
      const modelId = this.current ? null : this.availableModel(this.selectedModelId);
      if (!this.current && modelId === null)
        throw new Error('没有可用的模型，请由管理员在「模型管理」启用模型');
      const message = [
        this.input.trim(),
        ...this.draftAttachments.map((file) => `\n附件：${file.name}\n\`\`\`text\n${file.content}\n\`\`\``),
      ].join('\n');
      if (message.length > 64000) throw new Error('任务与文本附件合计不能超过 64000 字符');
      const generation = openGeneration;
      this.selectedScenarioId = scenarioId;
      this.selectedModelId = this.current ? switchTo : modelId;
      const submittedDraft = this.snapshotDraft();
      const originKey = this.draftKey;
      // 离开再回来时缓存的是这份草稿较早的快照：先更新为提交内容，受理后才能被正确清除，
      // 否则旧快照（如关联代码、模型选择）会在下一次新建任务时重新出现。
      if (this.drafts[originKey]?.id === submittedDraft.id) this.drafts[originKey] = submittedDraft;
      this.sending = true;
      this.runError = '';
      this.connectionWarning = '';
      this.liveText = '';
      this.liveReasoning = '';
      try {
        const prepared = preparedSessions.get(submittedDraft.id);
        if (prepared && pendingTurns.has(prepared.id))
          throw new Error('这份草稿仍在提交，请稍后再试；不会重复发送。');
        const session =
          this.current ??
          (prepared?.scenarioId === scenarioId && prepared.modelId === modelId
            ? prepared
            : await post<SessionDetail>('/agent/sessions', { scenarioId, modelId }));
        if (!this.current) rememberLastModel(platform.user?.username, session.modelId ?? modelId);
        // A navigation/new draft during an in-flight create must never attach its receipt
        // or text to another conversation. Backend execution, once accepted, continues.
        if (generation !== openGeneration) {
          await platform.refreshSessions();
          return null;
        }
        if (pendingTurns.has(session.id)) throw new Error('这份草稿仍在提交，请稍后再试；不会重复发送。');
        if (!this.current) preparedSessions.set(submittedDraft.id, session);
        // 新会话的关联代码随第一条消息提交；已有会话修改时即已保存，后端每轮按会话设置下发
        const codeProjects = this.current ? [] : submittedDraft.codeProjects;
        const pending = post<TurnReceipt>(`/agent/sessions/${session.id}/turns`, {
          message,
          ...(turnModelId !== null ? { modelId: turnModelId } : {}),
          ...(codeProjects.length ? { codeProjects } : {}),
        });
        pendingTurns.set(session.id, pending);
        let receipt;
        try {
          receipt = await pending;
        } finally {
          if (pendingTurns.get(session.id) === pending) pendingTurns.delete(session.id);
        }
        // A late accepted turn consumes only its own draft, never a newer task or reply.
        this.consumeDraft(originKey, submittedDraft);
        if (generation !== openGeneration) {
          await platform.refreshSessions();
          return null;
        }
        this.current = session;
        this.draftKey = `session:${session.id}`;
        if (receipt.codeProjects) this.current.codeProjects = receipt.codeProjects;
        this.draftCodeProjects = [];
        if (receipt.model) this.applyModel(receipt.model);
        this.selectedModelId = this.sessionModel(this.selectedModelId);
        this.messages.push({
          id: receipt.messageId,
          role: 'user',
          content: message,
          meta: receipt.messageMeta ?? {},
        });
        this.current.status = 'running';
        this.follow(session.id, receipt.cursor);
        await platform.refreshSessions();
        return generation === openGeneration ? session.id : null;
      } finally {
        if (generation === openGeneration) this.sending = false;
      }
    },
    /** 读取代码根目录下可关联的项目；失败时保留上次结果并抛出错误 */
    async loadCodeProjects() {
      const list = await api<CodeProjectList>('/code/projects');
      this.codeProjectList = list;
      return list;
    },
    /**
     * 修改关联代码（只读）。新会话只改草稿，随第一条消息提交；
     * 已有会话立即保存到服务端，执行中也可修改，从下一轮起生效。
     */
    async setCodeProjects(names: string[]) {
      const selected = [...new Set(names)].slice(0, MAX_CODE_PROJECTS);
      const session = this.current;
      if (!session) {
        this.draftCodeProjects = selected;
        return selected;
      }
      this.codeSaving = true;
      try {
        const result = await put<{ codeProjects: string[] }>(`/agent/sessions/${session.id}/code-projects`, {
          codeProjects: selected,
        });
        if (this.current?.id === session.id) this.current.codeProjects = result.codeProjects;
        return result.codeProjects;
      } finally {
        this.codeSaving = false;
      }
    },
    /** 本地同步会话当前模型（来自轮次回执或 model_switched 事件）。 */
    applyModel(model: { id: number | null; name: string; model: string; contextWindow?: number | null }) {
      if (!this.current) return;
      this.current.modelId = model.id;
      this.current.modelName = model.name || model.model;
      this.current.model = model.model;
      if (model.contextWindow) this.current.modelContextWindow = model.contextWindow;
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
          else if (event.kind === 'reasoning_delta') this.liveReasoning += data.text;
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
                meta: {
                  partial: data.partial,
                  runtimeMessageId: data.runtimeMessageId,
                  ...(data.reasoning ? { reasoning: data.reasoning } : {}),
                },
              });
            this.liveText = '';
            this.liveReasoning = '';
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
          else if (event.kind === 'model_switched') {
            this.applyModel({ ...data.to, contextWindow: data.contextWindow });
            this.selectedModelId = this.sessionModel(this.selectedModelId);
          } else if (event.kind === 'cost_tick') {
            // 单次模型请求的输入规模 ≈ 当前上下文，用于切换到小窗口模型前的提醒。
            if (data.tokensIn) this.current.contextTokens = data.tokensIn;
            this.current.tokensIn = data.totalTokensIn;
            this.current.tokensOut = data.totalTokensOut;
            this.current.cost = data.cost;
          } else if (event.kind === 'files' || event.kind === 'deliverables') {
            this.panel = 'files';
            void this.refreshFiles();
          } else if (event.kind === 'workspace_changes') {
            // 本轮改动记录挂到对应的用户消息上，结算回读数据库前即可展示
            const message = this.messages.find((item) => item.id === data.messageId);
            if (message) message.meta = { ...message.meta, workspaceChanges: data };
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
        this.liveReasoning = '';
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
        const result = await api<{ items: WorkspaceFile[]; retention?: FileRetention }>(
          `/agent/sessions/${id}/files`,
        );
        if (this.current?.id === id) {
          this.files = result.items;
          this.fileRetention = result.retention ?? null;
          this.filesLoaded = true;
        }
      } catch {
        // 读取失败时保留已展示的列表，避免短暂网络错误清空面板
      }
    },
    /** 删除会话文件：同时删除执行工作区与服务端副本 */
    async deleteFile(path: string) {
      const id = this.current?.id;
      if (!id) return;
      await remove(fileUrl(id, path));
      if (this.current?.id === id) {
        this.files = this.files.filter((file) => file.path !== path);
        void this.refreshFiles();
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
