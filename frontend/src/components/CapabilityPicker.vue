<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  MAX_SESSION_MCP,
  MAX_SESSION_SKILLS,
  emptyCapabilities,
  useConversation,
} from '../stores/conversation';
import { usePlatform } from '../stores/platform';
import type { CapabilityChoice, McpOption, SkillOption } from '../types/platform';
import Icon from './ForgeIcon.vue';

/**
 * 聊天输入框的「扩展能力」：临时选用 Skill、MCP 服务与联网搜索，与场景绑定的能力取并集。
 * 场景已绑定的项显示为已选且不可取消；新会话随第一条消息提交，已有会话确定后立即保存、从下一轮起生效。
 */
const emit = defineEmits<{ opened: []; changed: [] }>();
const app = usePlatform();
const chat = useConversation();
const open = ref(false);
const loading = ref(false);
const loadError = ref('');
const picked = ref<CapabilityChoice>(emptyCapabilities());
const root = ref<HTMLElement | null>(null);

/** 场景绑定的能力：已有会话取会话快照，新会话取所选场景当前版本 */
const scenario = computed(() => {
  if (chat.current) {
    const bound = chat.current.scenarioCapabilities;
    return {
      skillIds: bound?.skills.map((skill) => skill.id) ?? [],
      mcpServerIds: bound?.mcpServers.map((server) => server.id) ?? [],
      webSearch: Boolean(bound?.webSearch),
    };
  }
  const caps = app.scenarios.find((item) => item.id === chat.selectedScenarioId)?.payload.capabilities;
  return {
    skillIds: caps?.skill_ids ?? [],
    mcpServerIds: caps?.mcp_server_ids ?? [],
    webSearch: Boolean(caps?.web_search),
  };
});
const choice = computed(() => chat.capabilityChoice);
const count = computed(
  () =>
    new Set([...scenario.value.skillIds, ...choice.value.skillIds]).size +
    new Set([...scenario.value.mcpServerIds, ...choice.value.mcpServerIds]).size +
    (scenario.value.webSearch || choice.value.webSearch ? 1 : 0),
);
const label = computed(() => (count.value ? `扩展 · ${count.value}` : '扩展能力'));
const options = computed(() => chat.capabilityOptions);
const web = computed(() => options.value?.web);
/** 已选但已下线（取消发布、停用）的临时能力：单独列出，便于取消 */
const missingSkills = computed(() =>
  options.value ? picked.value.skillIds.filter((id) => !options.value?.skills.some((s) => s.id === id)) : [],
);
const missingServers = computed(() =>
  options.value
    ? picked.value.mcpServerIds.filter((id) => !options.value?.mcpServers.some((s) => s.id === id))
    : [],
);
const dirty = computed(() => JSON.stringify(picked.value) !== JSON.stringify(choice.value));

function approvalCount(server: McpOption) {
  return server.tools.filter((tool) => tool.permission === 'approval').length;
}
function skillHint(skill: SkillOption) {
  return [`/${skill.name}`, skill.version ? `v${skill.version}` : '', skill.description]
    .filter(Boolean)
    .join(' · ');
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
function toggle() {
  if (chat.loading || chat.sending) return;
  if (open.value) {
    open.value = false;
    return;
  }
  picked.value = {
    skillIds: [...choice.value.skillIds],
    mcpServerIds: [...choice.value.mcpServerIds],
    webSearch: choice.value.webSearch,
  };
  open.value = true;
  emit('opened');
  void load();
}
function flip(list: number[], id: number, limit: number, noun: string) {
  const index = list.indexOf(id);
  if (index >= 0) list.splice(index, 1);
  else if (list.length >= limit) app.toast(`一个会话最多临时选择 ${limit} 个${noun}`, 'info');
  else list.push(id);
}
async function apply(next = picked.value) {
  const inSession = Boolean(chat.current);
  const running = chat.running;
  try {
    await chat.setCapabilities(next);
    open.value = false;
    emit('changed');
    if (inSession)
      app.toast(running ? '扩展能力已保存，将从下一轮起生效' : '扩展能力已保存，下一条消息起生效', 'info');
  } catch (error) {
    app.toast((error as Error).message || '扩展能力保存失败', 'error');
  }
}
/** 输入框上方标签的移除按钮 */
async function remove(kind: 'skill' | 'mcp' | 'web', id?: number) {
  const current = choice.value;
  await apply({
    skillIds: kind === 'skill' ? current.skillIds.filter((item) => item !== id) : [...current.skillIds],
    mcpServerIds:
      kind === 'mcp' ? current.mcpServerIds.filter((item) => item !== id) : [...current.mcpServerIds],
    webSearch: kind === 'web' ? false : current.webSearch,
  });
}
function outside(event: PointerEvent) {
  if (root.value && !root.value.contains(event.target as Node)) open.value = false;
}
onMounted(() => document.addEventListener('pointerdown', outside));
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside));
defineExpose({ close: () => (open.value = false), remove });
</script>

<template>
  <div ref="root" class="code-picker-wrap">
    <button
      type="button"
      :class="['model-trigger', 'code-trigger', { 'is-active': count }]"
      :disabled="chat.loading || chat.capabilitySaving || chat.sending"
      :aria-expanded="open"
      aria-label="扩展能力"
      aria-controls="capability-options"
      title="临时选用 Skill、MCP 服务与联网搜索；与场景绑定的能力一起生效"
      @click="toggle"
      @keydown.esc.stop="open = false"
    >
      <span v-if="chat.capabilitySaving" class="loader small"></span><Icon v-else name="puzzle" :size="15" />
      <span>{{ label }}</span>
    </button>
    <div
      v-if="open"
      id="capability-options"
      class="scenario-popover code-popover capability-popover"
      role="dialog"
      aria-label="选择扩展能力"
      @keydown.esc.stop="open = false"
    >
      <div class="code-popover-head">
        <div class="popover-label">
          扩展能力<span>{{ chat.current ? '修改从下一轮起生效' : '随第一条消息生效' }}</span>
        </div>
      </div>
      <div class="code-options" role="group" aria-label="扩展能力">
        <div v-if="loading && !options" class="code-empty">
          <span class="loader small"></span>正在读取可用能力…
        </div>
        <div v-else-if="loadError && !options" class="code-empty is-error">
          {{ loadError }}<button type="button" @click="load">重试</button>
        </div>
        <template v-else-if="options">
          <div class="capability-group-title">
            <Icon name="book" :size="12" />Skill<small>输入 /名称 可直接调用</small>
          </div>
          <label
            v-for="skill in options.skills"
            :key="`skill-${skill.id}`"
            :class="[
              'code-option',
              { selected: scenario.skillIds.includes(skill.id) || picked.skillIds.includes(skill.id) },
            ]"
            :title="skill.description"
          >
            <input
              v-if="scenario.skillIds.includes(skill.id)"
              type="checkbox"
              checked
              disabled
              :aria-label="`${skill.title}（场景已绑定）`"
            />
            <input
              v-else
              type="checkbox"
              :checked="picked.skillIds.includes(skill.id)"
              @change="flip(picked.skillIds, skill.id, MAX_SESSION_SKILLS, ' Skill')"
            />
            <span
              ><strong>{{ skill.title }}</strong
              ><small>{{ skillHint(skill) }}</small></span
            >
            <em v-if="scenario.skillIds.includes(skill.id)" class="capability-tag">场景</em>
          </label>
          <label v-for="id in missingSkills" :key="`missing-skill-${id}`" class="code-option is-missing">
            <input
              type="checkbox"
              checked
              @change="flip(picked.skillIds, id, MAX_SESSION_SKILLS, ' Skill')"
            />
            <span
              ><strong>Skill #{{ id }}</strong
              ><small>已取消发布，取消勾选后保存</small></span
            >
          </label>
          <div v-if="!options.skills.length && !missingSkills.length" class="code-empty">
            还没有已发布的 Skill。<RouterLink to="/agent/skills">去 Skill 中心</RouterLink>
          </div>

          <div class="capability-group-title"><Icon name="plug" :size="12" />MCP 服务</div>
          <label
            v-for="server in options.mcpServers"
            :key="`mcp-${server.id}`"
            :class="[
              'code-option',
              {
                selected:
                  scenario.mcpServerIds.includes(server.id) || picked.mcpServerIds.includes(server.id),
              },
            ]"
            :title="server.tools.map((tool) => tool.name).join('、')"
          >
            <input
              v-if="scenario.mcpServerIds.includes(server.id)"
              type="checkbox"
              checked
              disabled
              :aria-label="`${server.name}（场景已绑定）`"
            />
            <input
              v-else
              type="checkbox"
              :checked="picked.mcpServerIds.includes(server.id)"
              @change="flip(picked.mcpServerIds, server.id, MAX_SESSION_MCP, ' MCP 服务')"
            />
            <span
              ><strong>{{ server.name }}</strong
              ><small
                >{{ server.transport === 'stdio' ? '本机进程' : 'Streamable HTTP' }} ·
                {{ server.tools.length }} 个工具{{
                  approvalCount(server) ? ` · ${approvalCount(server)} 个需确认` : ''
                }}</small
              ></span
            >
            <em v-if="scenario.mcpServerIds.includes(server.id)" class="capability-tag">场景</em>
          </label>
          <label v-for="id in missingServers" :key="`missing-mcp-${id}`" class="code-option is-missing">
            <input
              type="checkbox"
              checked
              @change="flip(picked.mcpServerIds, id, MAX_SESSION_MCP, ' MCP 服务')"
            />
            <span
              ><strong>MCP 服务 #{{ id }}</strong
              ><small>已停用或连接异常，取消勾选后保存</small></span
            >
          </label>
          <div v-if="!options.mcpServers.length && !missingServers.length" class="code-empty">
            没有可用的 MCP 服务（需管理员启用并测试连接）。
          </div>

          <div class="capability-group-title"><Icon name="globe" :size="12" />联网</div>
          <label
            :class="[
              'code-option',
              {
                selected: scenario.webSearch || picked.webSearch,
                'is-disabled': !web?.available && !picked.webSearch,
              },
            ]"
          >
            <input
              v-if="scenario.webSearch"
              type="checkbox"
              checked
              disabled
              aria-label="联网搜索（场景已绑定）"
            />
            <input
              v-else
              v-model="picked.webSearch"
              type="checkbox"
              :disabled="!web?.available && !picked.webSearch"
            />
            <span
              ><strong>联网搜索</strong
              ><small>{{
                web?.available
                  ? [web.searchReady ? 'web_search 搜索' : '', web.fetchEnabled ? 'web_fetch 读取网页' : '']
                      .filter(Boolean)
                      .join(' · ')
                  : web?.reason || '管理员尚未开启联网'
              }}</small></span
            >
            <em v-if="scenario.webSearch" class="capability-tag">场景</em>
          </label>
        </template>
      </div>
      <div class="code-popover-foot">
        <span>临时 Skill {{ picked.skillIds.length }} · MCP {{ picked.mcpServerIds.length }}</span>
        <button type="button" class="button secondary" @click="open = false">取消</button>
        <button
          type="button"
          class="button primary"
          :disabled="!dirty || chat.capabilitySaving"
          @click="apply()"
        >
          确定
        </button>
      </div>
    </div>
  </div>
</template>
