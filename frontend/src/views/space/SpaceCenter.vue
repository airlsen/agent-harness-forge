<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { MenuInfo } from 'ant-design-vue/es/menu/src/interface';
import Icon from '../../components/base/ForgeIcon.vue';
import SpaceMark from '../../components/space/SpaceMark.vue';
import SpaceFormDialog from '../../components/space/SpaceFormDialog.vue';
import { api, put } from '../../api/client';
import { PUBLIC_SPACE_ID, useSpace } from '../../stores/space';
import { usePlatform } from '../../stores/platform';
import type { Space, SpaceBrief, Tool } from '../../types/platform';
import { confirm, notify } from '../../utils/common/feedback';

/**
 * 空间管理：新建 / 编辑 / 删除空间，按空间关闭基础工具。
 * 删除空间时内容必须整体转移到另一个空间（默认公共），不提供连内容一起删除。
 */
const store = useSpace();
const platform = usePlatform();
const route = useRoute();
const router = useRouter();
const loading = ref(true);
const loadError = ref('');
const selectedId = computed(() => {
  const requested = Number(route.query.space);
  return store.spaces.some((item) => item.id === requested) ? requested : store.currentId;
});
const selected = computed<Space | undefined>(
  () => store.spaces.find((item) => item.id === selectedId.value) ?? store.spaces[0],
);
const COUNT_LABELS: { key: keyof Space['counts']; label: string }[] = [
  { key: 'scenarios', label: '场景' },
  { key: 'skills', label: 'Skill' },
  { key: 'mcp', label: 'MCP' },
  { key: 'plugins', label: '插件' },
  { key: 'sessions', label: '会话' },
];
function countSummary(space: Space) {
  const parts = COUNT_LABELS.filter(({ key }) => key !== 'sessions' && space.counts[key]).map(
    ({ key, label }) => `${label} ${space.counts[key]}`,
  );
  return parts.length ? parts.join(' · ') : '暂无内容';
}
function select(id: number) {
  void router.replace({ query: { ...route.query, space: id === store.currentId ? undefined : String(id) } });
}

// —— 基础工具开关 ——
const tools = ref<Tool[]>([]);
const toolsLoading = ref(false);
const toolBusy = ref<string | null>(null);
let toolGeneration = 0;
async function loadTools() {
  const space = selected.value;
  if (!space) return;
  const generation = ++toolGeneration;
  toolsLoading.value = true;
  try {
    const result = await api<{ items: Tool[] }>(`/spaces/${space.id}/tools`);
    if (generation === toolGeneration) tools.value = result.items;
  } catch (error) {
    if (generation === toolGeneration) notify('error', (error as Error).message);
  } finally {
    if (generation === toolGeneration) toolsLoading.value = false;
  }
}
const enabledCount = computed(() => tools.value.filter((tool) => tool.available).length);
async function toggleTool(tool: Tool, enabled: boolean) {
  const space = selected.value;
  if (!space || toolBusy.value) return;
  if (!enabled) {
    // 关闭前提示：本空间里哪些场景在用它
    toolBusy.value = tool.name;
    try {
      const { scenarios } = await api<{ scenarios: { id: number; name: string }[] }>(
        `/spaces/${space.id}/tools/${encodeURIComponent(tool.name)}/usage`,
      );
      if (scenarios.length) {
        const names = scenarios
          .slice(0, 5)
          .map((item) => `「${item.name}」`)
          .join('、');
        const ok = await confirm({
          title: `在「${space.name}」关闭${tool.title}？`,
          content: `本空间有 ${scenarios.length} 个场景用到它：${names}${scenarios.length > 5 ? ' 等' : ''}。关闭后这些场景从下一次新对话起不再使用它；已开始的对话不受影响。`,
          okText: '关闭',
          danger: true,
        });
        if (!ok) return;
      }
    } catch (error) {
      notify('error', (error as Error).message);
      return;
    } finally {
      toolBusy.value = null;
    }
  }
  toolBusy.value = tool.name;
  try {
    const result = await put<{ items: Tool[] }>(
      `/spaces/${space.id}/tools/${encodeURIComponent(tool.name)}`,
      { enabled },
    );
    tools.value = result.items;
    notify('success', `${tool.title}已在「${space.name}」${enabled ? '开启' : '关闭'}`);
    await store.load().catch(() => {});
    if (space.id === store.currentId) await platform.refreshTools().catch(() => {});
  } catch (error) {
    notify('error', (error as Error).message);
  } finally {
    toolBusy.value = null;
  }
}

// —— 新建 / 编辑 ——
const formOpen = ref(false);
const editing = ref<Space | null>(null);
function openCreate() {
  editing.value = null;
  formOpen.value = true;
}
function openEdit(space: Space) {
  editing.value = space;
  formOpen.value = true;
}
async function saved(space: Space, created: boolean) {
  if (!created) return;
  select(space.id);
  const ok = await confirm({
    title: `已创建「${space.name}」`,
    content: '现在切换到这个空间吗？切换后新建的场景、Skill、MCP 和插件会放进这个空间。',
    okText: '切换过去',
    cancelText: '留在当前空间',
  });
  if (ok) await store.switchTo(space.id, { remount: false });
}

// —— 删除（内容整体转移） ——
const deleting = ref<Space | null>(null);
const deleteTarget = ref<number>(PUBLIC_SPACE_ID);
const deleteCheck = ref<Awaited<ReturnType<typeof store.deleteCheck>> | null>(null);
const deleteChecking = ref(false);
const deleteError = ref('');
const deleteBusy = ref(false);
let deleteGeneration = 0;
const deleteTargets = computed(() => store.sorted.filter((item) => item.id !== deleting.value?.id));
const deleteTargetInfo = computed<SpaceBrief | undefined>(() => store.byId(deleteTarget.value));
const deleteCounts = computed(() =>
  deleting.value
    ? COUNT_LABELS.filter(({ key }) => deleting.value!.counts[key]).map(
        ({ key, label }) => `${deleting.value!.counts[key]} 个${label}`,
      )
    : [],
);
async function checkDelete() {
  const space = deleting.value;
  if (!space) return;
  const generation = ++deleteGeneration;
  deleteChecking.value = true;
  deleteError.value = '';
  deleteCheck.value = null;
  try {
    const result = await store.deleteCheck(space.id, deleteTarget.value);
    if (generation === deleteGeneration) deleteCheck.value = result;
  } catch (error) {
    if (generation === deleteGeneration) deleteError.value = (error as Error).message;
  } finally {
    if (generation === deleteGeneration) deleteChecking.value = false;
  }
}
function openDelete(space: Space) {
  deleting.value = space;
  deleteTarget.value = PUBLIC_SPACE_ID;
  void checkDelete();
}
function chooseDeleteTarget(id: number) {
  deleteTarget.value = id;
  void checkDelete();
}
const canDelete = computed(
  () =>
    Boolean(deleteCheck.value) &&
    !deleteChecking.value &&
    !deleteError.value &&
    !deleteCheck.value?.conflicts.length &&
    !deleteBusy.value,
);
async function confirmDelete() {
  const space = deleting.value;
  if (!space || !canDelete.value) return;
  deleteBusy.value = true;
  try {
    const wasCurrent = space.id === store.currentId;
    await store.remove(space.id, deleteTarget.value);
    notify(
      'success',
      deleteCheck.value?.empty
        ? `已删除「${space.name}」`
        : `已删除「${space.name}」，内容已转移到「${deleteTargetInfo.value?.name ?? '公共'}」`,
    );
    if (wasCurrent) notify('info', '已切换到公共空间');
    deleting.value = null;
    select(store.currentId);
  } catch (error) {
    deleteError.value = (error as Error).message;
  } finally {
    deleteBusy.value = false;
  }
}

function moreAction(info: MenuInfo, space: Space) {
  if (info.key === 'edit') openEdit(space);
  if (info.key === 'delete') openDelete(space);
}

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    await store.load();
  } catch (error) {
    loadError.value = (error as Error).message;
  } finally {
    loading.value = false;
  }
}
watch(
  () => selected.value?.id,
  () => void loadTools(),
);
onMounted(async () => {
  await load();
  await loadTools();
});
</script>
<template>
  <main class="page-content enterprise-page admin-theme-page">
    <div class="enterprise-page-inner">
      <div class="page-heading">
        <div>
          <h1>空间管理</h1>
          <p>按团队或业务划分场景、Skill、MCP 和插件；在账号菜单里切换空间。</p>
        </div>
        <!-- 按钮放进操作区，标题说明较长时也不会被挤压换行 -->
        <div class="page-heading-actions">
          <a-button type="primary" @click="openCreate">
            <template #icon><Icon name="plus" :size="16" /></template>新建空间
          </a-button>
        </div>
      </div>
      <div class="policy-intro">
        <Icon name="info" :size="18" /><span
          >每个空间只显示<b>本空间和公共空间</b>的内容；会话只显示在所在空间。基础工具开关只能在执行策略允许的范围内收紧，对<b>新建会话</b>生效。</span
        >
      </div>
      <a-alert v-if="loadError" type="error" show-icon message="空间列表未能读取" :description="loadError">
        <template #action><a-button size="small" @click="load">重试</a-button></template>
      </a-alert>
      <div v-else-if="loading && !store.spaces.length" class="loading-inline" role="status">
        <a-spin size="small" />正在读取空间…
      </div>
      <div v-else class="space-admin">
        <nav class="space-admin-list" aria-label="空间列表">
          <button
            v-for="item in store.sorted"
            :key="item.id"
            type="button"
            :class="['space-admin-item', { selected: selected?.id === item.id }]"
            :aria-current="selected?.id === item.id ? 'true' : undefined"
            @click="select(item.id)"
          >
            <SpaceMark :space="item" :size="28" />
            <span class="space-admin-item-text">
              <strong
                >{{ item.name
                }}<span v-if="item.id === store.currentId" class="space-admin-current">当前</span></strong
              >
              <small>{{ countSummary(item) }}</small>
            </span>
          </button>
        </nav>
        <section
          v-if="selected"
          class="settings-card space-admin-detail"
          :aria-label="`${selected.name}详情`"
        >
          <header class="space-admin-head">
            <SpaceMark :space="selected" :size="44" />
            <div class="space-admin-title">
              <h2>
                {{ selected.name }}
                <span v-if="selected.isPublic" class="tag soft">内置</span>
                <span v-if="selected.id === store.currentId" class="tag success">当前空间</span>
              </h2>
              <p>
                {{
                  selected.description ||
                  (selected.isPublic ? '所有空间都能看到和使用这里的内容。' : '暂无说明')
                }}
              </p>
            </div>
            <div class="space-admin-actions">
              <a-button
                v-if="selected.id !== store.currentId"
                type="primary"
                @click="store.switchTo(selected.id, { remount: false })"
                >切换到此空间</a-button
              >
              <a-button v-if="selected.isPublic" @click="openEdit(selected)">
                <template #icon><Icon name="edit" :size="15" /></template>编辑说明
              </a-button>
              <a-dropdown v-else :trigger="['click']" placement="bottomRight">
                <a-button :aria-label="`更多操作：${selected.name}`" title="更多操作">
                  <template #icon><Icon name="more" :size="16" /></template>
                </a-button>
                <template #overlay>
                  <a-menu @click="(info: MenuInfo) => moreAction(info, selected!)">
                    <a-menu-item key="edit"><Icon name="edit" :size="15" />编辑</a-menu-item>
                    <a-menu-divider />
                    <a-menu-item key="delete" danger
                      ><Icon name="delete-bin-line" :size="15" />删除空间</a-menu-item
                    >
                  </a-menu>
                </template>
              </a-dropdown>
            </div>
          </header>
          <dl class="space-admin-counts">
            <div v-for="item in COUNT_LABELS" :key="item.key">
              <dt>{{ item.label }}</dt>
              <dd>{{ selected.counts[item.key] }}</dd>
            </div>
          </dl>
          <div class="space-admin-section">
            <div class="space-admin-section-head">
              <h3>基础工具</h3>
              <span v-if="tools.length">已开启 {{ enabledCount }} / {{ tools.length }}</span>
            </div>
            <p class="section-description">
              默认全部开启。关闭后，这个空间的新会话不再使用该工具；执行策略未允许的工具在任何空间都不能开启。
            </p>
            <div v-if="toolsLoading && !tools.length" class="loading-inline" role="status">
              <a-spin size="small" />正在读取工具…
            </div>
            <ul v-else class="space-tool-list">
              <li v-for="tool in tools" :key="tool.name" :class="{ off: !tool.available }">
                <span class="tool-checkbox-icon"><Icon :name="tool.icon" :size="18" /></span>
                <div class="space-tool-text">
                  <strong
                    >{{ tool.title }}<small>{{ tool.name }}</small></strong
                  >
                  <p>{{ tool.description }}</p>
                </div>
                <span v-if="tool.policyAllowed === false" class="space-tool-note">
                  执行策略未允许
                  <RouterLink to="/agent/governance">去设置</RouterLink>
                </span>
                <a-switch
                  size="small"
                  :checked="Boolean(tool.available)"
                  :disabled="tool.policyAllowed === false || Boolean(toolBusy)"
                  :loading="toolBusy === tool.name"
                  :aria-label="`在${selected.name}${tool.available ? '关闭' : '开启'}${tool.title}`"
                  @change="(value: unknown) => toggleTool(tool, Boolean(value))"
                />
              </li>
            </ul>
          </div>
          <div v-if="!selected.isPublic" class="space-admin-section space-admin-danger">
            <div>
              <h3>删除空间</h3>
              <p class="section-description">
                空间里的内容和会话会整体转移到另一个空间（默认公共），不会被删除。
              </p>
            </div>
            <a-button danger @click="openDelete(selected)">删除空间</a-button>
          </div>
        </section>
      </div>
    </div>
    <SpaceFormDialog :open="formOpen" :space="editing" @close="formOpen = false" @saved="saved" />
    <a-modal
      :open="Boolean(deleting)"
      :width="500"
      centered
      :title="deleting ? `删除「${deleting.name}」` : '删除空间'"
      :mask-closable="!deleteBusy"
      :closable="!deleteBusy"
      @cancel="!deleteBusy && (deleting = null)"
    >
      <div v-if="deleting" class="space-delete">
        <p v-if="!deleteCounts.length">这个空间是空的，删除后不能恢复。</p>
        <template v-else>
          <p>
            空间里有
            {{
              deleteCounts.join('、')
            }}。删除后它们会整体转移到所选空间，已有会话也一起转移；基础工具开关随空间删除。
          </p>
          <div class="space-delete-targets" role="radiogroup" aria-label="内容转移到">
            <span>转移到</span>
            <button
              v-for="item in deleteTargets"
              :key="item.id"
              type="button"
              role="radio"
              :aria-checked="deleteTarget === item.id"
              :class="['space-delete-target', { selected: deleteTarget === item.id }]"
              :disabled="deleteBusy"
              @click="chooseDeleteTarget(item.id)"
            >
              <SpaceMark :space="item" :size="18" />{{ item.name }}
            </button>
          </div>
        </template>
        <div v-if="deleteChecking" class="loading-inline" role="status"><a-spin size="small" />正在检查…</div>
        <a-alert v-else-if="deleteError" type="error" show-icon :message="deleteError" />
        <a-alert
          v-else-if="deleteCheck?.conflicts.length"
          type="error"
          show-icon
          :message="`「${deleteTargetInfo?.name}」能看到同名 Skill，请先改名或换一个转移目标`"
        >
          <template #description>
            <ul class="space-delete-list">
              <li v-for="item in deleteCheck.conflicts" :key="item.id">
                「{{ item.name }}」与「{{ item.conflictSpace }}」空间的 Skill 重名
              </li>
            </ul>
          </template>
        </a-alert>
        <p v-if="deleting.id === store.currentId" class="space-delete-note">
          <Icon name="info" :size="14" />这是你当前所在的空间，删除后会切换到公共空间。
        </p>
      </div>
      <template #footer>
        <a-button :disabled="deleteBusy" @click="deleting = null">取消</a-button>
        <a-button danger type="primary" :disabled="!canDelete" :loading="deleteBusy" @click="confirmDelete">
          {{ deleteCounts.length ? `转移内容并删除` : '删除空间' }}
        </a-button>
      </template>
    </a-modal>
  </main>
</template>
<style scoped>
.space-admin {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.space-admin-list {
  display: grid;
  gap: 4px;
  max-height: calc(100vh - 260px);
  padding: 6px;
  overflow-y: auto;
  border: 1px solid var(--border-default);
  border-radius: 10px;
  background: var(--surface-card);
}
.space-admin-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 7px;
  text-align: left;
}
.space-admin-item:hover {
  background: var(--surface-hover);
}
.space-admin-item.selected {
  background: var(--surface-selected);
}
.space-admin-item:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
}
.space-admin-item-text {
  display: grid;
  min-width: 0;
}
.space-admin-item-text strong {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}
.space-admin-item-text small {
  overflow: hidden;
  color: var(--color-text-tertiary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.space-admin-current {
  padding: 0 5px;
  border-radius: 4px;
  background: var(--color-success-bg);
  color: var(--color-success-text);
  font-size: 12px;
  font-weight: 500;
  line-height: 17px;
}
.space-admin-detail {
  display: grid;
  gap: 22px;
}
.space-admin-head {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}
.space-admin-title {
  flex: 1;
  min-width: 0;
}
.space-admin-title h2 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--color-text-primary);
  font-size: 18px;
  font-weight: 600;
}
.space-admin-title p {
  margin: 4px 0 0;
  color: var(--color-text-secondary);
  font-size: 13px;
}
.space-admin-actions {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
}
.space-admin-counts {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
}
.space-admin-counts > div {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--surface-subtle-bg);
}
.space-admin-counts dt {
  color: var(--color-text-tertiary);
  font-size: 12px;
}
.space-admin-counts dd {
  margin: 2px 0 0;
  color: var(--color-text-primary);
  font-size: 20px;
  font-weight: 600;
}
.space-admin-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.space-admin-section h3 {
  margin: 0;
  color: var(--color-text-primary);
  font-size: 14px;
  font-weight: 600;
}
.space-admin-section-head span {
  color: var(--color-text-tertiary);
  font-size: 12px;
}
.space-tool-list {
  display: grid;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--border-light);
  border-radius: 8px;
}
.space-tool-list li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
}
.space-tool-list li + li {
  border-top: 1px solid var(--border-light);
}
.space-tool-list li.off .space-tool-text {
  opacity: 0.6;
}
.space-tool-text {
  flex: 1;
  min-width: 0;
}
.space-tool-text strong {
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 600;
}
.space-tool-text strong small {
  color: var(--color-text-tertiary);
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  font-weight: 400;
}
.space-tool-text p {
  margin: 2px 0 0;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.space-tool-note {
  flex-shrink: 0;
  color: var(--color-warning-text);
  font-size: 12px;
}
.space-admin-danger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-top: 18px;
  border-top: 1px solid var(--border-light);
}
.space-admin-danger .section-description {
  margin: 4px 0 0;
}
.space-delete {
  display: grid;
  gap: 12px;
}
.space-delete p {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 13px;
}
.space-delete-targets {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.space-delete-targets > span {
  margin-right: 4px;
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 550;
}
.space-delete-target {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px 4px 5px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--color-text-primary);
  font-size: 13px;
}
.space-delete-target.selected {
  border-color: var(--color-brand);
  background: var(--surface-selected);
}
.space-delete-target:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}
.space-delete-list {
  margin: 4px 0 0;
  padding-left: 18px;
}
.space-delete-note {
  display: flex;
  align-items: center;
  gap: 6px;
}
@media (max-width: 960px) {
  .space-admin {
    grid-template-columns: 1fr;
  }
  .space-admin-counts {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
