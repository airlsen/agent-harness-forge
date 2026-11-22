<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { MAX_SESSION_MCP, MAX_SESSION_SKILLS, useConversation } from '../../stores/conversation';
import { usePlatform } from '../../stores/platform';
import type { McpOption, SkillOption } from '../../types/platform';
import Icon from '../base/ForgeIcon.vue';

/**
 * 聊天输入框的「扩展技能」：临时选用 Skill、MCP 服务与联网搜索，与场景绑定的能力取并集。
 * 场景已绑定的项显示为已选且不可取消。点选即改输入框中的选择，随下一条消息一起提交。
 */
const emit = defineEmits<{ opened: [] }>();
const app = usePlatform();
const chat = useConversation();
const open = ref(false);
const loading = ref(false);
const loadError = ref('');
const query = ref('');
const search = ref<{ focus: () => void } | null>(null);

/** 场景绑定的能力：已有会话取会话快照，新会话取所选场景当前版本 */
const scenario = computed(() => {
  if (chat.current) {
    const bound = chat.current.scenarioCapabilities;
    return {
      skillIds: bound?.skills.map((skill) => skill.id) ?? [],
      mcpServerIds: bound?.mcpServers.map((server) => server.id) ?? [],
      webSearch: Boolean(bound?.webSearch),
      names: new Map<string, string>([
        ...(bound?.skills ?? []).map((skill) => [`skill-${skill.id}`, skill.title] as [string, string]),
        ...(bound?.mcpServers ?? []).map((server) => [`mcp-${server.id}`, server.name] as [string, string]),
      ]),
    };
  }
  const caps = app.scenarios.find((item) => item.id === chat.selectedScenarioId)?.payload.capabilities;
  return {
    skillIds: caps?.skill_ids ?? [],
    mcpServerIds: caps?.mcp_server_ids ?? [],
    webSearch: Boolean(caps?.web_search),
    names: new Map<string, string>(),
  };
});
const choice = computed(() => chat.capabilityChoice);
const options = computed(() => chat.capabilityOptions);
const web = computed(() => options.value?.web);

const skillOn = (id: number) => scenario.value.skillIds.includes(id) || choice.value.skillIds.includes(id);
const serverOn = (id: number) =>
  scenario.value.mcpServerIds.includes(id) || choice.value.mcpServerIds.includes(id);
const webOn = computed(() => scenario.value.webSearch || choice.value.webSearch);

/** 本轮将生效的全部扩展技能名称（场景 ∪ 临时选择），用于触发按钮 */
const activeNames = computed(() => {
  const skillIds = [...new Set([...scenario.value.skillIds, ...choice.value.skillIds])];
  const serverIds = [...new Set([...scenario.value.mcpServerIds, ...choice.value.mcpServerIds])];
  return [
    ...skillIds.map(
      (id) =>
        options.value?.skills.find((skill) => skill.id === id)?.title ??
        scenario.value.names.get(`skill-${id}`) ??
        `Skill #${id}`,
    ),
    ...serverIds.map(
      (id) =>
        options.value?.mcpServers.find((server) => server.id === id)?.name ??
        scenario.value.names.get(`mcp-${id}`) ??
        `MCP #${id}`,
    ),
    ...(webOn.value ? ['联网搜索'] : []),
  ];
});
const label = computed(() => {
  const [first, ...rest] = activeNames.value;
  if (!first) return '扩展技能';
  return rest.length ? `${first} +${rest.length}` : first;
});
const title = computed(
  () =>
    (activeNames.value.length
      ? `扩展技能：${activeNames.value.join('、')}`
      : '临时选用 Skill、MCP 服务与联网搜索；与场景绑定的能力一起生效') +
    (chat.capabilitiesPending ? ' · 随下一条消息生效' : ''),
);
const hint = computed(() =>
  chat.capabilitiesPending
    ? '随下一条消息生效'
    : activeNames.value.length
      ? `已选 ${activeNames.value.length}`
      : '可多选',
);

const keyword = computed(() => query.value.trim().toLowerCase());
const match = (...values: string[]) =>
  !keyword.value || values.some((value) => value.toLowerCase().includes(keyword.value));
const skills = computed(() => (options.value?.skills ?? []).filter((s) => match(s.title, s.name)));
const servers = computed(() => (options.value?.mcpServers ?? []).filter((s) => match(s.name)));
const searchable = computed(
  () => (options.value?.skills.length ?? 0) + (options.value?.mcpServers.length ?? 0) > 8,
);
/** 已选但已下线（取消发布、停用）的临时能力：单独列出，点击即可移除 */
const missingSkills = computed(() =>
  options.value
    ? choice.value.skillIds.filter(
        (id) => !scenario.value.skillIds.includes(id) && !options.value?.skills.some((s) => s.id === id),
      )
    : [],
);
const missingServers = computed(() =>
  options.value
    ? choice.value.mcpServerIds.filter(
        (id) =>
          !scenario.value.mcpServerIds.includes(id) && !options.value?.mcpServers.some((s) => s.id === id),
      )
    : [],
);

function approvalCount(server: McpOption) {
  return server.tools.filter((tool) => tool.permission === 'approval').length;
}
function skillHint(skill: SkillOption) {
  return [`/${skill.name}`, skill.version ? `v${skill.version}` : ''].filter(Boolean).join(' · ');
}
async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    await chat.loadCapabilityOptions();
  } catch (error) {
    loadError.value = (error as Error).message || '未能读取可用能力';
  } finally {
    loading.value = false;
  }
}
// 有已选能力时预先读取名称，触发按钮才能显示名称而不是编号
watch(
  () => Boolean(activeNames.value.length) && !options.value,
  (missing) => {
    if (missing) chat.loadCapabilityOptions().catch(() => undefined);
  },
  { immediate: true },
);
function toggle(visible: boolean) {
  if (chat.loading || chat.sending) return;
  if (!visible) {
    open.value = false;
    return;
  }
  query.value = '';
  open.value = true;
  emit('opened');
  void load().then(() => nextTick(() => search.value?.focus()));
}
function flip(kind: 'skill' | 'mcp', id: number) {
  const current = choice.value;
  const key = kind === 'skill' ? 'skillIds' : 'mcpServerIds';
  const limit = kind === 'skill' ? MAX_SESSION_SKILLS : MAX_SESSION_MCP;
  const list = current[key];
  if (list.includes(id)) {
    chat.setCapabilities({ ...current, [key]: list.filter((item) => item !== id) });
    return;
  }
  if (list.length >= limit) {
    app.toast(`一个会话最多临时选择 ${limit} 个${kind === 'skill' ? ' Skill' : ' MCP 服务'}`, 'info');
    return;
  }
  chat.setCapabilities({ ...current, [key]: [...list, id] });
}
function flipWeb() {
  const current = choice.value;
  // 已开启的可以随时关闭；未开启时须平台已允许联网
  if (!current.webSearch && !web.value?.available) return;
  chat.setCapabilities({ ...current, webSearch: !current.webSearch });
}
defineExpose({ close: () => (open.value = false) });
</script>

<template>
  <div class="code-picker-wrap">
    <a-popover
      :open="open"
      trigger="click"
      placement="bottomLeft"
      overlay-class-name="task-picker-overlay"
      @open-change="toggle"
    >
      <button
        type="button"
        :class="['model-trigger', 'picker-trigger', { 'is-active': activeNames.length }]"
        :disabled="chat.loading || chat.sending"
        :aria-expanded="open"
        aria-label="扩展技能"
        aria-controls="capability-options"
        :title="title"
        @keydown.esc.stop="open = false"
      >
        <Icon name="puzzle" :size="15" />
        <span class="picker-trigger-label">{{ label }}</span>
        <i v-if="chat.capabilitiesPending" class="picker-dot" aria-label="有未发送的修改"></i>
      </button>
      <template #content>
        <div
          id="capability-options"
          class="scenario-popover picker-popover capability-popover"
          role="dialog"
          aria-label="选择扩展技能"
          @keydown.esc.stop="open = false"
        >
          <div class="picker-head">
            <span>扩展技能</span><small :class="{ 'is-pending': chat.capabilitiesPending }">{{ hint }}</small>
          </div>
          <div v-if="searchable" class="picker-search">
            <Icon name="search" :size="13" />
            <a-input
              ref="search"
              v-model:value="query"
              placeholder="搜索 Skill 或 MCP 服务"
              aria-label="搜索扩展技能"
            />
          </div>
          <div class="picker-list">
            <div v-if="loading && !options" class="picker-empty">
              <span class="loader small"></span>正在读取可用能力…
            </div>
            <div v-else-if="loadError && !options" class="picker-empty is-error">
              {{ loadError }}<button type="button" @click="load">重试</button>
            </div>
            <template v-else-if="options">
              <div class="picker-group" role="group" aria-label="Skill">
                <div class="picker-group-title">Skill<small>输入 /名称 可直接调用</small></div>
                <a-checkbox
                  v-for="skill in skills"
                  :key="`skill-${skill.id}`"
                  :checked="skillOn(skill.id)"
                  :disabled="scenario.skillIds.includes(skill.id)"
                  :class="[
                    'picker-row',
                    { selected: skillOn(skill.id), 'is-locked': scenario.skillIds.includes(skill.id) },
                  ]"
                  :title="skill.description || skill.title"
                  @change="flip('skill', skill.id)"
                >
                  <span class="picker-row-main"
                    ><b>{{ skill.title }}</b
                    ><small>{{ skillHint(skill) }}</small></span
                  ><em v-if="scenario.skillIds.includes(skill.id)" class="picker-tag">场景</em>
                </a-checkbox>
                <button
                  v-for="id in missingSkills"
                  :key="`missing-skill-${id}`"
                  type="button"
                  :aria-label="`移除失效的 Skill ${id}`"
                  class="picker-row is-missing selected"
                  @click="flip('skill', id)"
                >
                  <span class="picker-row-main"
                    ><b>Skill #{{ id }}</b
                    ><small>已取消发布，点击移除</small></span
                  ><Icon name="close" :size="14" />
                </button>
                <div v-if="!skills.length && !missingSkills.length" class="picker-empty">
                  <template v-if="keyword">没有匹配的 Skill</template>
                  <template v-else
                    >还没有已发布的 Skill。<RouterLink to="/agent/skills">去 Skill 中心</RouterLink></template
                  >
                </div>
              </div>

              <div class="picker-group" role="group" aria-label="MCP 服务">
                <div class="picker-group-title">MCP 服务</div>
                <a-checkbox
                  v-for="server in servers"
                  :key="`mcp-${server.id}`"
                  :checked="serverOn(server.id)"
                  :disabled="scenario.mcpServerIds.includes(server.id)"
                  :class="[
                    'picker-row',
                    { selected: serverOn(server.id), 'is-locked': scenario.mcpServerIds.includes(server.id) },
                  ]"
                  :title="server.tools.map((tool) => tool.name).join('、')"
                  @change="flip('mcp', server.id)"
                >
                  <span class="picker-row-main"
                    ><b>{{ server.name }}</b
                    ><small
                      >{{ server.transport === 'stdio' ? '本机进程' : 'HTTP' }} ·
                      {{ server.tools.length }} 个工具{{
                        approvalCount(server) ? ` · ${approvalCount(server)} 个需确认` : ''
                      }}</small
                    ></span
                  ><em v-if="scenario.mcpServerIds.includes(server.id)" class="picker-tag">场景</em>
                </a-checkbox>
                <button
                  v-for="id in missingServers"
                  :key="`missing-mcp-${id}`"
                  type="button"
                  :aria-label="`移除失效的 MCP 服务 ${id}`"
                  class="picker-row is-missing selected"
                  @click="flip('mcp', id)"
                >
                  <span class="picker-row-main"
                    ><b>MCP #{{ id }}</b
                    ><small>已停用或连接异常，点击移除</small></span
                  ><Icon name="close" :size="14" />
                </button>
                <div v-if="!servers.length && !missingServers.length" class="picker-empty">
                  {{ keyword ? '没有匹配的 MCP 服务' : '暂无可用的 MCP 服务（需管理员启用并测试连接）' }}
                </div>
              </div>

              <div v-if="!keyword" class="picker-group" role="group" aria-label="联网">
                <div class="picker-group-title">联网</div>
                <a-checkbox
                  :checked="webOn"
                  :disabled="scenario.webSearch || (!choice.webSearch && !web?.available)"
                  :class="[
                    'picker-row',
                    {
                      selected: webOn,
                      'is-locked': scenario.webSearch,
                      'is-disabled': !scenario.webSearch && !choice.webSearch && !web?.available,
                    },
                  ]"
                  @change="flipWeb()"
                >
                  <span class="picker-row-main"
                    ><b>联网搜索</b
                    ><small>{{
                      web?.available
                        ? [web.searchReady ? '搜索网络' : '', web.fetchEnabled ? '读取网页' : '']
                            .filter(Boolean)
                            .join(' · ')
                        : web?.reason || '管理员尚未开启联网'
                    }}</small></span
                  ><em v-if="scenario.webSearch" class="picker-tag">场景</em>
                </a-checkbox>
              </div>
            </template>
          </div>
        </div>
      </template>
    </a-popover>
  </div>
</template>
