import { defineStore } from 'pinia';
import { api, post, setCsrf } from '../api/client';
import type { Conversation, ModelConnection, RuntimeStatus, Scenario, Tool } from '../types/platform';

export const usePlatform = defineStore('platform', {
  state: () => ({
    authenticated: false,
    authLoading: true,
    user: null as null | { name: string; username: string; workspace: string },
    scenarios: [] as Scenario[],
    conversations: [] as Conversation[],
    tools: [] as Tool[],
    connection: null as ModelConnection | null,
    runtime: null as RuntimeStatus | null,
    loading: false,
    notice: null as null | { message: string; type: 'success' | 'error' | 'info' },
  }),
  actions: {
    toast(message: string, type: 'success' | 'error' | 'info' = 'success') {
      this.notice = { message, type };
      setTimeout(() => {
        if (this.notice?.message === message) this.notice = null;
      }, 6000);
    },
    async checkAuth() {
      try {
        const data = await api('/auth/session');
        this.authenticated = data.authenticated;
        this.user = data.user;
        setCsrf(data.csrfToken ?? '');
      } finally {
        this.authLoading = false;
      }
    },
    async login(username: string, password: string) {
      await post('/auth/login', { username, password });
      await this.checkAuth();
      await this.initialize();
    },
    async logout() {
      await post('/auth/logout');
      this.authenticated = false;
      this.user = null;
      this.conversations = [];
      setCsrf('');
    },
    async initialize() {
      this.loading = true;
      try {
        const [scenarios, sessions, tools, connection, runtime] = await Promise.all([
          api<Scenario[]>('/agent-scenarios'),
          api<{ items: Conversation[] }>('/agent/sessions'),
          api<{ items: Tool[] }>('/registry/tools'),
          api<ModelConnection>('/models/connection'),
          api<RuntimeStatus>('/runtime/status'),
        ]);
        this.scenarios = scenarios;
        this.conversations = sessions.items;
        this.tools = tools.items;
        this.connection = connection;
        this.runtime = runtime;
      } finally {
        this.loading = false;
      }
    },
    async refreshScenarios() {
      this.scenarios = await api<Scenario[]>('/agent-scenarios');
    },
    async refreshSessions() {
      this.conversations = (await api<{ items: Conversation[] }>('/agent/sessions')).items;
    },
    async refreshRuntime() {
      this.runtime = await api<RuntimeStatus>('/runtime/status');
      this.connection = await api<ModelConnection>('/models/connection');
    },
  },
});
