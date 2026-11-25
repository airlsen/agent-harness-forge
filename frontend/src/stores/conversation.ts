import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import { api, post, remove } from '../api/client';
import { openEventStream } from '../api/events';
import { usePlatform } from './platform';
import { fileUrl, type FileRetention, type WorkspaceFile } from '../utils/file/files';
import { createLiveBuffer, isLiveDelta, type LiveBuffer } from '../utils/conversation/liveBuffer';
import type { ToolCallView } from '../utils/conversation/turns';
import type {
  Approval,
  CapabilityChoice,
  CapabilityOptions,
  ChatMessage,
  CodeProjectList,
  KernelEvent,
  PendingQuestion,
  QuestionAnswerPayload,
  SessionDetail,
  SessionModelSegment,
} from '../types/platform';
let stream: { close: () => void } | null = null;
// 当前事件流的流式片段缓冲：合并后再写入 liveText / liveReasoning
let liveBuffer: LiveBuffer | null = null;
/**
 * 聊天页需要保留的过程事件（「过程」面板、错误提示、工具状态）。底层轨迹只计数、流式片段只拼接实时正文，
 * 都不进入页面状态：长会话中它们有成千上万条，逐条保留会让页面越来越慢。
 */
export const PROCESS_KINDS = [
  'model_switched',
  'workspace_changes',
  'tool_use_start',
  'tool_result',
  'approval_required',
  'approval_resolved',
  'question_required',
  'question_resolved',
  'error',
  'message',
  'compaction',
];
const PROCESS_KIND_SET = new Set(PROCESS_KINDS);
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
  /** 关联代码的完整选择：随下一条消息提交（已有会话与已生效的选择不同即待提交） */
  codeProjects: string[];
  /** 临时扩展能力的完整选择：规则同关联代码 */
  capabilities: CapabilityChoice;
}
/** 一个会话最多关联的代码项目数，与后端、Runner 一致 */
export const MAX_CODE_PROJECTS = 20;
/** 一个会话最多临时选择的 Skill / MCP 服务数，与后端一致 */
export const MAX_SESSION_SKILLS = 20;
export const MAX_SESSION_MCP = 10;
export const emptyCapabilities = (): CapabilityChoice => ({
  skillIds: [],
  mcpServerIds: [],
  webSearch: false,
});
const copyCapabilities = (choice: CapabilityChoice | undefined): CapabilityChoice => ({
  skillIds: [...(choice?.skillIds ?? [])],
  mcpServerIds: [...(choice?.mcpServerIds ?? [])],
  webSearch: Boolean(choice?.webSearch),
});
/** 两个已去重的选择是否相同（与顺序无关：取消后重新勾选不算修改） */
const sameList = <T>(left: T[], right: T[]) =>
  left.length === right.length && left.every((item) => right.includes(item));
export const sameCapabilities = (left: CapabilityChoice, right: CapabilityChoice) =>
  sameList(left.skillIds, right.skillIds) &&
  sameList(left.mcpServerIds, right.mcpServerIds) &&
  Boolean(left.webSearch) === Boolean(right.webSearch);
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
  capabilities?: CapabilityChoice;
}
function copyDraft(draft: TaskDraft): TaskDraft {
  return {
    ...draft,
    attachments: draft.attachments.map((file) => ({ ...file })),
    codeProjects: [...draft.codeProjects],
    capabilities: copyCapabilities(draft.capabilities),
  };
}
function sameDraft(left: TaskDraft, right: TaskDraft) {
  return (
    left.id === right.id &&
    left.scenarioId === right.scenarioId &&
    left.modelId === right.modelId &&
    left.preview === right.preview &&
    left.input === right.input &&
    JSON.stringify(left.attachments) === JSON.stringify(right.attachments) &&
    JSON.stringify(left.codeProjects) === JSON.stringify(right.codeProjects) &&
    JSON.stringify(left.capabilities) === JSON.stringify(right.capabilities)
  );
}

/** 读取已落库的过程事件（只取 PROCESS_KINDS，跳过底层轨迹与旧版落库的流式片段） */
async function trajectory(id: number, last: number) {
  const events: KernelEvent[] = [];
  const kinds = encodeURIComponent(PROCESS_KINDS.join(','));
  let cursor = 0;
  while (true) {
    const page = await api<{ events: KernelEvent[]; nextCursor: number }>(
      `/agent/sessions/${id}/trajectory?cursor=${cursor}&kinds=${kinds}`,
    );
    for (const event of page.events) events.push(markRaw(event));
    if (!page.events.length || page.nextCursor >= last) break;
    cursor = page.nextCursor;
  }
  return events;
}
export const useConversation = defineStore('conversation', {
  state: () => ({
    current: null as SessionDetail | null,
    messages: [] as ChatMessage[],
    /** 过程事件（PROCESS_KINDS）；事件对象不做深层响应式 */
    events: [] as KernelEvent[],
    /** 已处理到的持久事件序号：事件流去重与续读位置 */
    lastSeq: 0,
    /** 底层轨迹事件数（聊天页只显示数量，完整内容在执行轨迹页） */
    trajectoryEventCount: 0,
    /** 已开始、尚未返回结果的工具调用 */
    activeTools: [] as ToolCallView[],
    approvals: [] as Approval[],
    /** 模型向用户提问的卡片（含已结束的：置灰显示回答状态） */
    questions: [] as PendingQuestion[],
    files: [] as WorkspaceFile[],
    fileRetention: null as FileRetention | null,
    /** 文件清单已从服务端读取过（用于区分「加载中」与「文件已被删除」） */
    filesLoaded: false,
    selectedScenarioId: null as number | null,
    previewScenarioId: null as number | null,
    selectedModelId: null as number | null,
    input: '',
    draftAttachments: [] as { name: string; content: string }[],
    /** 输入框中的关联代码选择，随下一条消息提交（已有会话初始为已生效的选择） */
    draftCodeProjects: [] as string[],
    /** 代码根目录下的项目列表（打开选择器时刷新） */
    codeProjectList: null as CodeProjectList | null,
    /** 输入框中的临时扩展能力选择，随下一条消息提交 */
    draftCapabilities: emptyCapabilities(),
    /** 可选的扩展能力（打开选择器或能力面板时刷新） */
    capabilityOptions: null as CapabilityOptions | null,
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
    /**
     * 已发出、尚未被服务端受理的消息：立即显示在对话里（「正在准备…」），受理后换成正式消息；
     * 失败时标为「发送失败」，内容放回输入框。只在当前页面显示，不改变 current / messages。
     */
    outgoing: null as null | { content: string; failed: boolean; draft: TaskDraft },
    loading: false,
    runError: '',
    connectionWarning: '',
    /** 本轮正在排队等待并发额度；null 表示未排队 */
    queue: null as null | { position: number; capacity: number },
    /** 对话过长，执行内核正在后台整理（压缩）上下文 */
    compacting: false,
    panel: 'files' as 'context' | 'trajectory' | 'files',
    panelOpen: false,
  }),
  getters: {
    running: (state) => state.sending || state.current?.status === 'running',
    /** 输入框中选择的关联代码（随下一条消息提交） */
    codeProjects: (state): string[] => state.draftCodeProjects,
    /** 已生效的关联代码：已有会话为服务端记录，新会话为空 */
    appliedCodeProjects: (state): string[] => state.current?.codeProjects ?? [],
    /** 已有会话中关联代码有未发送的修改 */
    codePending(): boolean {
      return Boolean(this.current) && !sameList(this.draftCodeProjects, this.appliedCodeProjects);
    },
    /** 输入框中选择的临时扩展能力（随下一条消息提交） */
    capabilityChoice: (state): CapabilityChoice => state.draftCapabilities,
    appliedCapabilities: (state): CapabilityChoice => state.current?.capabilities ?? emptyCapabilities(),
    capabilitiesPending(): boolean {
      return Boolean(this.current) && !sameCapabilities(this.draftCapabilities, this.appliedCapabilities);
    },
    hasUnsentDrafts: (state) =>
      Boolean(
        state.input.trim() ||
        state.draftAttachments.length ||
        (state.outgoing && !state.outgoing.failed) ||
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
      liveBuffer?.clear();
      liveBuffer = null;
    },
    /** 记录一条持久事件：过程事件保留，工具调用同步到进行中列表 */
    recordEvent(event: KernelEvent) {
      if (event.kind === 'trajectory') ++this.trajectoryEventCount;
      if (!PROCESS_KIND_SET.has(event.kind)) return;
      this.events.push(markRaw(event));
      const data = event.payload ?? {};
      if (event.kind === 'compaction') this.compacting = data.phase === 'start';
      else if (event.kind === 'tool_use_start') {
        const id = String(data.toolCallId ?? `tool-${event.seq}`);
        if (!this.activeTools.some((call) => call.id === id))
          this.activeTools.push({ id, tool: data.tool, arguments: data.arguments, pending: true });
      } else if (event.kind === 'tool_result') {
        const id = String(data.toolCallId ?? '');
        if (this.activeTools.some((call) => call.id === id))
          this.activeTools = this.activeTools.filter((call) => call.id !== id);
      }
    },
    snapshotDraft(): TaskDraft {
      if (!this.draftId) this.draftId = ++this.draftSequence;
      // 提交中的内容已从输入框移到对话里，但在受理前仍属于这份草稿（离开再回来、失败重试都要用到）。
      const sending = this.outgoing;
      if (sending && !sending.failed && sending.draft.id === this.draftId) return copyDraft(sending.draft);
      return {
        id: this.draftId,
        input: this.input,
        attachments: this.draftAttachments.map((file) => ({ ...file })),
        scenarioId: this.selectedScenarioId,
        modelId: this.selectedModelId,
        preview: this.selectedScenarioId !== null && this.selectedScenarioId === this.previewScenarioId,
        codeProjects: [...this.draftCodeProjects],
        capabilities: copyCapabilities(this.draftCapabilities),
      };
    },
    saveDraft() {
      // An opening session has not restored its cached draft yet. Do not overwrite it.
      if (this.loading || (this.draftKey !== 'new' && !this.current)) return;
      const draft = this.snapshotDraft();
      // 已有会话里只改了模型、关联代码或扩展能力，尚未输入内容，同样保留这份选择。
      const pendingSelection = Boolean(
        this.current &&
        (draft.modelId !== this.current.modelId || this.codePending || this.capabilitiesPending),
      );
      if (draft.input || draft.attachments.length || pendingSelection || this.draftKey === 'new')
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
      this.lastSeq = 0;
      this.trajectoryEventCount = 0;
      this.activeTools = [];
      this.approvals = [];
      this.questions = [];
      this.files = [];
      this.fileRetention = null;
      this.filesLoaded = false;
      this.liveText = '';
      this.liveReasoning = '';
      this.runError = '';
      this.connectionWarning = '';
      this.queue = null;
      this.compacting = false;
      this.sending = false;
      this.outgoing = null;
      this.loading = false;
      this.input = '';
      this.draftAttachments = [];
      this.draftCodeProjects = [];
      this.draftCapabilities = emptyCapabilities();
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
      // 已有会话没有缓存的修改时，从已生效的选择开始
      this.draftCodeProjects = [...(draft?.codeProjects ?? this.current?.codeProjects ?? [])];
      this.draftCapabilities = copyCapabilities(draft?.capabilities ?? this.current?.capabilities);
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
      if (this.outgoing?.failed) this.outgoing = null;
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
        this.questions = detail.pendingQuestions ?? [];
        this.trajectoryEventCount = detail.trajectoryEventCount ?? 0;
        for (const event of events) this.recordEvent(event);
        this.lastSeq = Math.max(detail.lastEventSeq, events.at(-1)?.seq ?? 0);
        const lastError = [...events].reverse().find((event) => event.kind === 'error');
        if (['error', 'interrupted'].includes(detail.status))
          this.runError = lastError?.payload.message ?? '上一次任务未完成';
        void this.refreshFiles();
        // 尚未结算的正文与思考由事件流的快照（live_snapshot）补上。
        // detail 的消息快照与事件读取可能有时间差；结算时统一回读数据库去重。
        if (detail.status === 'running') this.follow(id, this.lastSeq);
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
      if (!this.current && modelId === null) throw new Error('没有可用的模型，请在「模型连接」启用模型');
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
      this.activeTools = [];
      // 先把消息显示出来、清空输入框；新会话的创建与受理在后台进行（首轮约 1–2 秒）。
      this.outgoing = { content: message, failed: false, draft: copyDraft(submittedDraft) };
      this.input = '';
      this.draftAttachments = [];
      ++this.draftRevision;
      let accepted = false;
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
        // 关联代码与扩展能力随消息提交：只在与已生效的选择不同时携带（空选择表示全部取消），
        // 不携带则后端沿用会话已保存的选择。校验失败时整轮被拒绝，输入与选择都保留。
        const appliedCode = this.current?.codeProjects ?? [];
        const appliedCaps = this.current?.capabilities ?? emptyCapabilities();
        const sendCode = !sameList(submittedDraft.codeProjects, appliedCode);
        const sendCaps = !sameCapabilities(submittedDraft.capabilities, appliedCaps);
        const pending = post<TurnReceipt>(`/agent/sessions/${session.id}/turns`, {
          message,
          ...(turnModelId !== null ? { modelId: turnModelId } : {}),
          ...(sendCode ? { codeProjects: submittedDraft.codeProjects } : {}),
          ...(sendCaps ? { capabilities: submittedDraft.capabilities } : {}),
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
        if (receipt.capabilities) this.current.capabilities = receipt.capabilities;
        // 提交后输入框中的选择即已生效的选择
        this.draftCodeProjects = [...(this.current.codeProjects ?? [])];
        this.draftCapabilities = copyCapabilities(this.current.capabilities);
        if (receipt.model) this.applyModel(receipt.model);
        this.selectedModelId = this.sessionModel(this.selectedModelId);
        accepted = true;
        this.outgoing = null;
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
      } catch (error) {
        // 未受理：标为「发送失败」，把文字和附件放回输入框（离开过本页则草稿已另存，不再回填）。
        if (!accepted && generation === openGeneration && this.outgoing) {
          this.outgoing = { ...this.outgoing, failed: true };
          this.input = submittedDraft.input;
          this.draftAttachments = submittedDraft.attachments.map((file) => ({ ...file }));
          ++this.draftRevision;
        }
        throw error;
      } finally {
        if (generation === openGeneration) {
          this.sending = false;
          if (this.outgoing && !this.outgoing.failed) this.outgoing = null;
        }
      }
    },
    /** 读取代码根目录下可关联的项目；失败时保留上次结果并抛出错误 */
    async loadCodeProjects() {
      const list = await api<CodeProjectList>('/code/projects');
      this.codeProjectList = list;
      return list;
    },
    /**
     * 选择关联代码（只读）：只改输入框中的选择，随下一条消息一起提交并从该轮起生效。
     * 执行中也可以选择；提交中的消息已带上原选择，此时不允许修改。
     */
    setCodeProjects(names: string[]): string[] {
      if (this.sending || this.loading) return this.draftCodeProjects;
      this.draftCodeProjects = [...new Set(names)].slice(0, MAX_CODE_PROJECTS);
      return this.draftCodeProjects;
    },
    /** 读取可选的扩展能力（已发布 Skill、可运行的 MCP 服务、联网状态）；失败时保留上次结果并抛出错误 */
    async loadCapabilityOptions() {
      const options = await api<CapabilityOptions>('/capabilities/options');
      this.capabilityOptions = options;
      return options;
    },
    /**
     * 切换空间后校正新会话草稿：场景、临时选择的 Skill / MCP 只能来自新空间或公共空间。
     * 已有会话不受影响（打开别的空间的会话时会自动切到它所在的空间）。
     */
    async adaptDraftToSpace() {
      const platform = usePlatform();
      // 失败重试时复用的预建会话属于原空间，切换后不再复用
      preparedSessions.clear();
      const keep = (scenarioId: number | null | undefined) =>
        platform.availableScenarios.some((item) => item.id === scenarioId) ||
        (scenarioId !== null &&
          scenarioId === this.previewScenarioId &&
          platform.scenarios.some((item) => item.id === scenarioId));
      const draft = this.drafts.new;
      if (!this.current && this.draftKey === 'new' && !keep(this.selectedScenarioId)) {
        this.selectedScenarioId = platform.availableScenarios[0]?.id ?? null;
        this.previewScenarioId = null;
      }
      if (draft && !keep(draft.scenarioId)) draft.scenarioId = platform.availableScenarios[0]?.id ?? null;
      const hasPicks = (choice?: CapabilityChoice) =>
        Boolean(choice?.skillIds.length || choice?.mcpServerIds.length);
      const live = !this.current && this.draftKey === 'new';
      if (!(live && hasPicks(this.draftCapabilities)) && !hasPicks(draft?.capabilities)) return;
      const options = await this.loadCapabilityOptions();
      const skills = new Set(options.skills.map((item) => item.id));
      const servers = new Set(options.mcpServers.map((item) => item.id));
      const narrow = (choice: CapabilityChoice): CapabilityChoice => ({
        skillIds: choice.skillIds.filter((id) => skills.has(id)),
        mcpServerIds: choice.mcpServerIds.filter((id) => servers.has(id)),
        webSearch: choice.webSearch,
      });
      if (live) this.draftCapabilities = narrow(this.draftCapabilities);
      if (draft?.capabilities) draft.capabilities = narrow(draft.capabilities);
    },
    /** 选择临时扩展能力（Skill / MCP / 联网）：规则同关联代码，随下一条消息提交。 */
    setCapabilities(choice: CapabilityChoice): CapabilityChoice {
      if (this.sending || this.loading) return this.draftCapabilities;
      this.draftCapabilities = {
        skillIds: [...new Set(choice.skillIds)].slice(0, MAX_SESSION_SKILLS),
        mcpServerIds: [...new Set(choice.mcpServerIds)].slice(0, MAX_SESSION_MCP),
        webSearch: Boolean(choice.webSearch),
      };
      return this.draftCapabilities;
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
      this.lastSeq = Math.max(this.lastSeq, after);
      const buffer = createLiveBuffer((text, reasoning) => {
        if (this.current?.id !== id) return;
        this.liveText += text;
        this.liveReasoning += reasoning;
      });
      liveBuffer = buffer;
      stream = openEventStream(`/api/agent/sessions/${id}/events?after=${after}`, {
        kernel: (event) => {
          if (this.current?.id !== id) return;
          // 持久事件按序号去重；流式片段与快照没有序号
          if (typeof event.seq === 'number') {
            if (event.seq <= this.lastSeq) return;
            this.lastSeq = event.seq;
          }
          const data = event.payload ?? {};
          if (isLiveDelta(event.kind)) {
            buffer.push(event.kind, String(data.text ?? ''));
            return;
          }
          if (event.kind === 'live_reset') {
            // 模型请求失败后自动重试：上一次尝试的正文与思考作废，由重试的输出重新填充
            buffer.clear();
            this.liveText = '';
            this.liveReasoning = '';
            return;
          }
          // 其他事件处理前先写入已攒下的片段，保证先后顺序
          buffer.flush();
          if (event.kind === 'live_snapshot') {
            // 订阅时尚未结算的正文与思考：整体替换（重连后不会重复拼接）
            this.liveText = String(data.text ?? '');
            this.liveReasoning = String(data.reasoning ?? '');
            return;
          }
          this.recordEvent(event);
          if (event.kind === 'message') {
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
          else if (event.kind === 'question_required')
            this.questions = [...this.questions, { ...data, status: 'pending' }];
          else if (event.kind === 'question_resolved')
            this.questions = this.questions.map((question) =>
              question.ticketId === data.ticketId ? { ...question, status: data.action } : question,
            );
          else if (event.kind === 'error') this.runError = data.message;
          else if (event.kind === 'queued') this.queue = { position: data.position, capacity: data.capacity };
          else if (event.kind === 'dequeued') this.queue = null;
          else if (event.kind === 'done') {
            this.queue = null;
            this.compacting = false;
          } else if (event.kind === 'model_switched') {
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
        this.questions = detail.pendingQuestions ?? [];
        this.liveText = '';
        this.liveReasoning = '';
        this.activeTools = [];
        this.queue = null;
        this.compacting = false;
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
    /** 回答或忽略模型的一批提问；失败时重开当前会话以恢复服务端状态 */
    async resolveQuestion(ticketId: number, payload: QuestionAnswerPayload) {
      try {
        await post(`/agent/questions/${ticketId}/resolve`, payload);
        this.questions = this.questions.map((question) =>
          question.ticketId === ticketId
            ? { ...question, status: payload.action === 'cancel' ? 'cancelled' : 'answered' }
            : question,
        );
      } catch (error) {
        if (this.current) void this.open(this.current.id);
        throw error;
      }
    },
  },
});
