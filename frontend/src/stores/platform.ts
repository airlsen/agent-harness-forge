import { defineStore } from 'pinia';
import { api, post, setCsrf, setPreviewSession } from '../api/client';
import type {
  Conversation,
  ModelConnection,
  ModelOption,
  RuntimeStatus,
  Scenario,
  Tool,
} from '../types/platform';
import { isAvailableScenario } from '../utils/conversation/sessionState';
import { notify } from '../utils/common/feedback';

export const usePlatform = defineStore('platform', {
  state: () => ({
    authenticated: false,
    authLoading: true,
    previewHeaderAuth: false,
    registrationAvailable: false,
    registrationRequiresEmailVerification: false,
    user: null as null | { id: string; name: string; username: string; role: string; workspace: string },
    scenarios: [] as Scenario[],
    conversations: [] as Conversation[],
    tools: [] as Tool[],
    connection: null as ModelConnection | null,
    // 聊天模型选择：仅启用的模型；defaultId 为平台默认（未设置时为最早的启用配置）
    modelOptions: [] as ModelOption[],
    defaultModelId: null as number | null,
    runtime: null as RuntimeStatus | null,
    loading: false,
  }),
  getters: {
    availableScenarios: (state) =>
      state.scenarios.filter(isAvailableScenario).map((scenario) =>
        scenario.status === 'published' && scenario.published_payload
          ? {
              ...scenario,
              current_version: scenario.published_version,
              payload: scenario.published_payload,
              bundleHash: scenario.published_bundle_hash ?? scenario.bundleHash,
            }
          : scenario,
      ),
    regularConversations: (state) => state.conversations.filter((item) => !item.isTest),
  },
  actions: {
    toast(message: string, type: 'success' | 'error' | 'info' = 'success') {
      // 交由 antd message 呈现；同一文案连发时由 antd 自行去重/堆叠，无需手动计时。
      notify(type, message);
    },
    async checkAuth() {
      try {
        const data = await api('/auth/session');
        this.authenticated = data.authenticated;
        this.user = data.user;
        this.previewHeaderAuth = data.previewHeaderAuth;
        this.registrationAvailable = data.registrationAvailable;
        this.registrationRequiresEmailVerification = data.registrationRequiresEmailVerification;
        if (!data.authenticated) setPreviewSession(null);
        setCsrf(data.csrfToken ?? '');
      } finally {
        this.authLoading = false;
      }
    },
    async login(username: string, password: string) {
      setPreviewSession(null);
      setCsrf('');
      await post('/auth/login', { username, password });
      let auth = await api('/auth/session');
      let cookieWorks = auth.authenticated;
      // 检测真正的业务请求，不能把 login 的 200 或 session 的 200 当成登录成功。
      if (cookieWorks) {
        try {
          await api('/registry/tools');
        } catch (error) {
          if ((error as { status: number }).status !== 401) throw error;
          cookieWorks = false;
        }
      }
      if (!cookieWorks) {
        if (!auth.previewHeaderAuth)
          throw new Error('密码已验证，但预览环境未保留登录 Cookie。请允许 Cookie 或从新标签页登录。');
        const result = await post('/auth/login', { username, password, transport: 'preview-header' });
        setPreviewSession(result.previewSession);
        auth = await api('/auth/session');
      }
      if (!auth.authenticated) throw new Error('预览会话未能建立，请刷新预览后重试；无需更改账号密码。');
      setCsrf(auth.csrfToken);
      await this.initialize();
      this.authenticated = true;
      this.user = auth.user;
      this.previewHeaderAuth = auth.previewHeaderAuth;
      this.registrationAvailable = auth.registrationAvailable;
      this.registrationRequiresEmailVerification = auth.registrationRequiresEmailVerification;
      if (!cookieWorks) this.toast('已使用预览兼容会话：仅当前标签页、1 小时有效', 'info');
    },
    async logout() {
      try {
        await post('/auth/logout');
      } finally {
        this.authenticated = false;
        this.user = null;
        this.conversations = [];
        setPreviewSession(null);
        setCsrf('');
      }
    },
    async register(values: { username: string; email: string; password: string; display_name: string }) {
      return post<{ verificationRequired: boolean }>('/auth/register', values);
    },
    async verifyEmail(token: string) {
      return post('/auth/verify-email', { token });
    },
    async initialize() {
      this.loading = true;
      try {
        const [scenarios, sessions, tools, connection, runtime, models] = await Promise.all([
          api<Scenario[]>('/agent-scenarios'),
          api<{ items: Conversation[] }>('/agent/sessions'),
          api<{ items: Tool[] }>('/registry/tools'),
          api<ModelConnection>('/models/connection'),
          api<RuntimeStatus>('/runtime/status'),
          api<{ items: ModelOption[]; defaultId: number | null }>('/models/options'),
        ]);
        this.scenarios = scenarios;
        this.conversations = sessions.items;
        this.tools = tools.items;
        this.connection = connection;
        this.runtime = runtime;
        this.modelOptions = models.items;
        this.defaultModelId = models.defaultId;
      } finally {
        this.loading = false;
      }
    },
    async refreshScenarios() {
      this.scenarios = await api<Scenario[]>('/agent-scenarios');
    },
    async refreshSessions() {
      const identity = this.user?.username;
      const result = await api<{ items: Conversation[] }>('/agent/sessions');
      if (this.authenticated && this.user?.username === identity) this.conversations = result.items;
    },
    /** 基础工具清单（含当前空间是否开启、执行策略是否允许） */
    async refreshTools() {
      this.tools = (await api<{ items: Tool[] }>('/registry/tools')).items;
    },
    async refreshModelOptions() {
      const models = await api<{ items: ModelOption[]; defaultId: number | null }>('/models/options');
      this.modelOptions = models.items;
      this.defaultModelId = models.defaultId;
    },
    async refreshRuntime() {
      // 模型管理的任何改动（增删、启停、设为默认）都经由这里刷新聊天可选模型。
      const [runtime, connection] = await Promise.all([
        api<RuntimeStatus>('/runtime/status'),
        api<ModelConnection>('/models/connection'),
        this.refreshModelOptions(),
      ]);
      this.runtime = runtime;
      this.connection = connection;
    },
  },
});
