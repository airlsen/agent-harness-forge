<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Empty } from 'ant-design-vue';
import Icon from '../ForgeIcon.vue';
import PanelSection from '../catalog/PanelSection.vue';
import type { McpServer, McpTool } from '../../types/mcp';
import { drawerA11y, useRetained } from '../../utils/overlay';
import { mcpState, transportLabel } from '../../utils/mcp';

/**
 * MCP 工具清单：右侧抽屉，和「工具详情」同一套写法。
 * 基本信息 + 工具列表两个分组；工具默认收起，展开查看 inputSchema 里的参数。
 */
const props = defineProps<{ server: McpServer | null; testing?: boolean }>();
const emit = defineEmits<{ close: []; test: [server: McpServer] }>();

const shown = useRetained(() => props.server);
const query = ref('');
watch(
  () => props.server?.id,
  (id, previous) => {
    if (id && id !== previous) query.value = '';
  },
);

const simpleEmptyImage = Empty.PRESENTED_IMAGE_SIMPLE;
const tools = computed(() => shown.value?.tools ?? []);
const visibleTools = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  return tools.value.filter((tool) => `${tool.name} ${tool.description}`.toLowerCase().includes(keyword));
});
const version = computed(() => {
  const value = shown.value?.serverInfo?.version;
  return value ? String(value) : '';
});

type Param = { name: string; type: string; required: boolean; description: string };
function toolParams(tool: McpTool): Param[] {
  const schema = tool.inputSchema ?? {};
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(properties).map(([name, prop]) => ({
    name,
    type: Array.isArray(prop?.type)
      ? prop.type.join(' | ')
      : String(prop?.type ?? (prop?.enum ? 'enum' : 'any')),
    required: required.has(name),
    description: String(prop?.description ?? ''),
  }));
}
</script>

<template>
  <a-drawer
    :open="!!server"
    :width="520"
    class="drawer mcp-tools-drawer"
    v-bind="drawerA11y('MCP 工具清单', !!server)"
    @close="emit('close')"
  >
    <template v-if="shown" #title>
      <div class="mcp-drawer-title">
        <h2>{{ shown.name }}</h2>
        <a-tag :bordered="false" :color="mcpState(shown).color">{{ mcpState(shown).label }}</a-tag>
      </div>
    </template>
    <template v-if="shown">
      <PanelSection icon="info" title="基本信息">
        <dl class="mcp-info">
          <dt>协议</dt>
          <dd>{{ transportLabel(shown.transport) }}</dd>
          <template v-if="shown.transport !== 'stdio'">
            <dt>地址</dt>
            <dd class="mono">{{ shown.url }}</dd>
          </template>
          <template v-if="version">
            <dt>版本</dt>
            <dd class="mono">{{ version }}</dd>
          </template>
          <dt>工具</dt>
          <dd>{{ tools.length }} 项</dd>
          <dt>认证</dt>
          <dd>{{ shown.hasCredentials ? '已加密保存' : '无' }}</dd>
        </dl>
        <p v-if="shown.lastError" class="mcp-last-error" role="alert">
          <Icon name="close-line" :size="14" />{{ shown.lastError }}
        </p>
      </PanelSection>

      <PanelSection icon="tools-line" title="工具列表">
        <template v-if="tools.length > 8" #extra>
          <a-input
            v-model:value="query"
            class="mcp-tools-search"
            size="small"
            placeholder="搜索工具"
            aria-label="搜索 MCP 工具"
            allow-clear
          >
            <template #prefix><Icon name="search" :size="14" /></template>
          </a-input>
        </template>
        <a-collapse v-if="visibleTools.length" class="mcp-tool-list" ghost expand-icon-position="end">
          <a-collapse-panel v-for="tool in visibleTools" :key="tool.name">
            <template #header>
              <div class="mcp-tool-head">
                <code>{{ tool.name }}</code>
                <p>{{ tool.description || '未提供用途说明' }}</p>
              </div>
            </template>
            <template #extra>
              <span class="mcp-tool-count">{{
                toolParams(tool).length ? `${toolParams(tool).length} 个参数` : '无参数'
              }}</span>
            </template>
            <div
              v-if="toolParams(tool).length"
              class="mcp-params"
              role="table"
              :aria-label="`${tool.name} 参数`"
            >
              <div v-for="param in toolParams(tool)" :key="param.name" class="mcp-param" role="row">
                <code role="cell">{{ param.name }}</code>
                <span role="cell" class="mcp-param-type">{{ param.type }}</span>
                <span role="cell" class="mcp-param-required">{{ param.required ? '必填' : '' }}</span>
                <span role="cell" class="mcp-param-desc">{{ param.description || '—' }}</span>
              </div>
            </div>
            <p v-else class="mcp-params-none">无需参数</p>
          </a-collapse-panel>
        </a-collapse>
        <a-empty
          v-else
          class="mcp-tools-empty"
          :image="simpleEmptyImage"
          :description="tools.length ? '没有匹配的工具' : '尚未读取到工具'"
        >
          <a-button v-if="!tools.length" type="primary" :loading="testing" @click="emit('test', shown)">
            测试连接
          </a-button>
        </a-empty>
      </PanelSection>
    </template>
    <template #footer>
      <div class="mcp-drawer-footer">
        <a-button v-if="shown && tools.length" :loading="testing" @click="emit('test', shown)">
          <template #icon><Icon name="refresh" :size="14" /></template>测试连接
        </a-button>
        <a-button @click="emit('close')">关闭</a-button>
      </div>
    </template>
  </a-drawer>
</template>

<style scoped>
.mcp-drawer-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.mcp-drawer-title h2 {
  margin: 0;
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: 16px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mcp-drawer-title :deep(.ant-tag) {
  flex-shrink: 0;
  margin: 0;
}
.mono,
.mcp-tool-head code,
.mcp-param code {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}

/* 基本信息：标签左、值右，和参考表单同样的对齐 */
.mcp-info {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  gap: 10px 12px;
  margin: 0;
  font-size: 13px;
}
.mcp-info dt {
  color: var(--color-text-tertiary);
}
.mcp-info dd {
  margin: 0;
  color: var(--color-text-primary);
  overflow-wrap: anywhere;
}
.mcp-last-error {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  margin: 12px 0 0;
  color: var(--color-danger-text);
  font-size: 12px;
  line-height: 1.6;
}
.mcp-last-error :deep(svg) {
  flex-shrink: 0;
  margin-top: 3px;
}

.mcp-tools-search {
  width: 180px;
}
.mcp-tools-search :deep(.ant-input) {
  min-height: 0; /* 中和 style.css 全局 :where(input){min-height:41px} */
}

/* 工具列表：白底条目，默认收起 */
.mcp-tool-list :deep(.ant-collapse-item) {
  margin-bottom: 8px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--surface-card);
}
.mcp-tool-list :deep(.ant-collapse-item:last-child) {
  margin-bottom: 0;
}
.mcp-tool-list :deep(.ant-collapse-header) {
  align-items: flex-start;
  padding: 10px 12px;
}
.mcp-tool-list :deep(.ant-collapse-content-box) {
  padding: 0 12px 12px;
}
.mcp-tool-head {
  min-width: 0;
}
.mcp-tool-head code {
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.mcp-tool-head p {
  display: -webkit-box;
  margin: 2px 0 0;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.6;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.mcp-tool-count {
  color: var(--color-text-tertiary);
  font-size: 12px;
  white-space: nowrap;
}
.mcp-params {
  display: grid;
  border-top: 1px solid var(--border-default);
}
.mcp-param {
  display: grid;
  grid-template-columns: minmax(72px, auto) auto 32px minmax(0, 1fr);
  align-items: baseline;
  gap: 8px;
  padding: 8px 0;
  font-size: 12px;
}
.mcp-param + .mcp-param {
  border-top: 1px dashed var(--border-default);
}
.mcp-param code {
  color: var(--color-text-primary);
  overflow-wrap: anywhere;
}
.mcp-param-type {
  color: var(--color-info-text);
}
.mcp-param-required {
  color: var(--color-warning-text);
}
.mcp-param-desc,
.mcp-params-none {
  color: var(--color-text-secondary);
  line-height: 1.6;
}
.mcp-params-none {
  margin: 0;
  padding-top: 8px;
  border-top: 1px solid var(--border-default);
  font-size: 12px;
}
.mcp-tools-empty {
  margin: 12px 0;
}

.mcp-drawer-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.mcp-drawer-footer :deep(.ant-btn) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
</style>
