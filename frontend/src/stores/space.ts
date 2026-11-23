import { defineStore } from 'pinia';
import { api, post, put, remove as del, setSpaceHeader, SPACE_STORAGE_KEY } from '../api/client';
import type { MoveCheck, Space, SpaceBrief, SpaceColor, SpaceResourceKind } from '../types/platform';
import { notify } from '../utils/common/feedback';
import { usePlatform } from './platform';
import { useConversation } from './conversation';

/** 公共空间固定为 1：内置，不能删除或改名，内容在每个空间都能看到 */
export const PUBLIC_SPACE_ID = 1;
export const SPACE_COLORS: { value: SpaceColor; label: string }[] = [
  { value: 'orange', label: '橙' },
  { value: 'blue', label: '蓝' },
  { value: 'green', label: '绿' },
  { value: 'purple', label: '紫' },
  { value: 'red', label: '红' },
  { value: 'cyan', label: '青' },
  { value: 'yellow', label: '黄' },
  { value: 'pink', label: '粉' },
];
export const MAX_SPACE_NAME = 20;
export const MAX_SPACE_DESCRIPTION = 100;
/** 空间较多时，账号菜单改为「切换空间 ›」并提供搜索 */
export const INLINE_SPACE_LIMIT = 6;
export const PUBLIC_SPACE: SpaceBrief = { id: PUBLIC_SPACE_ID, name: '公共', color: 'gray', isPublic: true };

export interface SpaceInput {
  name: string;
  color: SpaceColor | '';
  description: string;
}

type Saved = { id: number; name: string };
function readSaved(): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(SPACE_STORAGE_KEY) ?? 'null');
    if (Number.isInteger(saved?.id) && saved.id > 0)
      return { id: saved.id, name: typeof saved.name === 'string' ? saved.name : '' };
  } catch {
    // 本地存储不可用：使用公共空间
  }
  return { id: PUBLIC_SPACE_ID, name: PUBLIC_SPACE.name };
}
function persist(space: SpaceBrief) {
  try {
    localStorage.setItem(SPACE_STORAGE_KEY, JSON.stringify({ id: space.id, name: space.name }));
  } catch {
    // 仅本次页面有效
  }
}

/** 空间排序：公共在最前，其余按名称 */
export function sortSpaces<T extends SpaceBrief>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    a.isPublic === b.isPublic ? a.name.localeCompare(b.name, 'zh-Hans-CN') : a.isPublic ? -1 : 1,
  );
}

export const useSpace = defineStore('space', {
  state: () => ({
    spaces: [] as Space[],
    currentId: readSaved().id,
    /** 切换空间时递增：页面据此重新挂载并读取本空间的数据 */
    version: 0,
    loaded: false,
  }),
  getters: {
    current(state): SpaceBrief {
      return (
        state.spaces.find((item) => item.id === state.currentId) ?? {
          ...PUBLIC_SPACE,
          // 列表还没读到时，先用本地记住的名称，避免闪成「公共」
          ...(state.currentId !== PUBLIC_SPACE_ID
            ? { id: state.currentId, name: readSaved().name, color: 'blue' }
            : {}),
        }
      );
    },
    sorted(state): Space[] {
      return sortSpaces(state.spaces);
    },
    /** 当前就在公共空间：所有内容都是公共的，不再逐条显示「公共」标记 */
    inPublic(state): boolean {
      return state.currentId === PUBLIC_SPACE_ID;
    },
  },
  actions: {
    byId(id: number | null | undefined): SpaceBrief | undefined {
      if (!id) return undefined;
      return (
        this.spaces.find((item) => item.id === id) ?? (id === PUBLIC_SPACE_ID ? PUBLIC_SPACE : undefined)
      );
    },
    apply(id: number) {
      this.currentId = id;
      setSpaceHeader(id);
      persist(this.current);
    },
    /**
     * 读取空间列表。当前空间已被删除时回到公共空间并提示，返回 true（调用方需刷新数据）。
     */
    async load(): Promise<boolean> {
      const { items } = await api<{ items: Space[] }>('/spaces');
      this.spaces = items;
      this.loaded = true;
      if (!items.some((item) => item.id === this.currentId)) {
        const name = readSaved().name;
        this.apply(PUBLIC_SPACE_ID);
        this.version++;
        notify('info', name ? `「${name}」已被删除，已切换到公共空间` : '已切换到公共空间');
        await this.refreshData();
        return true;
      }
      persist(this.current);
      return false;
    },
    /** 切换后重新读取侧栏与全局列表；页面通过 version 变化重新挂载 */
    async refreshData() {
      const platform = usePlatform();
      const chat = useConversation();
      chat.capabilityOptions = null;
      if (!platform.authenticated) return;
      try {
        await Promise.all([platform.refreshScenarios(), platform.refreshSessions(), platform.refreshTools()]);
        await chat.adaptDraftToSpace();
        if (!chat.capabilityOptions) await chat.loadCapabilityOptions();
      } catch (error) {
        notify('error', (error as Error).message);
      }
    },
    /**
     * 切换空间。
     * quiet：不弹提示；remount=false：留在当前页面（打开别的空间的会话链接时自动切换）。
     */
    async switchTo(id: number, options: { quiet?: boolean; remount?: boolean; reason?: string } = {}) {
      if (id === this.currentId) return;
      this.apply(id);
      if (options.remount !== false) this.version++;
      if (!options.quiet) notify('success', `已切换到「${this.current.name}」${options.reason ?? ''}`);
      await this.refreshData();
    },
    /** 打开的内容属于别的空间时自动切过去（留在当前页面） */
    async follow(id: number | null | undefined, reason = '') {
      if (!id || id === this.currentId) return;
      // 未读到列表时先读一次，提示里才有名称
      if (!this.byId(id)) await this.load().catch(() => {});
      if (!this.byId(id)) return;
      await this.switchTo(id, { remount: false, reason });
    },
    async create(input: SpaceInput): Promise<Space> {
      const created = await post<Space>('/spaces', input);
      await this.load();
      return created;
    },
    async update(id: number, input: SpaceInput): Promise<Space> {
      const updated = await put<Space>(`/spaces/${id}`, input);
      await this.load();
      return updated;
    },
    async deleteCheck(id: number, target: number | null) {
      return api<{
        space: Space;
        empty: boolean;
        target: SpaceBrief | null;
        conflicts: { id: number; name: string; conflictSpace: string }[];
      }>(`/spaces/${id}/delete-check${target ? `?target=${target}` : ''}`);
    },
    async remove(id: number, target: number | null) {
      const result = await del(`/spaces/${id}${target ? `?target=${target}` : ''}`);
      if (id === this.currentId) {
        // 删掉的是当前空间：回到公共空间
        this.apply(PUBLIC_SPACE_ID);
        this.version++;
        await this.refreshData();
      }
      await this.load();
      return result;
    },
    async moveCheck(kind: SpaceResourceKind, id: number | string, targetSpaceId: number) {
      return post<MoveCheck>('/spaces/move/check', { kind, id: String(id), targetSpaceId });
    },
    async move(kind: SpaceResourceKind, id: number | string, targetSpaceId: number) {
      const result = await post<MoveCheck>('/spaces/move', { kind, id: String(id), targetSpaceId });
      await this.load().catch(() => {});
      return result;
    },
  },
});
