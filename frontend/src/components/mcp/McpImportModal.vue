<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { MenuInfo } from 'ant-design-vue/es/menu/src/interface';
import { post } from '../../api/client';
import Icon from '../ForgeIcon.vue';
import PanelSection from '../catalog/PanelSection.vue';
import type { McpServer } from '../../types/mcp';
import { previewMcpImport, transportLabel, type McpImportEntry } from '../../utils/mcp';

/**
 * 添加 MCP 服务：只粘贴 mcpServers JSON。
 * 协议由 JSON 自身决定（type / command），不再用下拉框覆盖；输入时实时识别服务并标出覆盖、HTTPS 等问题。
 */
const props = defineProps<{ existingNames: string[] }>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ imported: [items: McpServer[], testAfterImport: boolean] }>();

const examples: Record<string, unknown> = {
  http: {
    type: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer <token>' },
  },
  stdio: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/folder'],
    env: {},
  },
  sse: { type: 'sse', url: 'https://mcp.example.com/sse' },
};
const exampleMenu = [
  { key: 'http', label: '远程服务（Streamable HTTP）' },
  { key: 'stdio', label: '本机程序（stdio）' },
  { key: 'sse', label: '旧版 SSE（仅测试连接）' },
];
function exampleText(key: string) {
  return JSON.stringify({ mcpServers: { 'my-service': examples[key] } }, null, 2);
}
const placeholder = exampleText('http');

const json = ref('');
const testAfterImport = ref(true);
const submitting = ref(false);
const serverError = ref('');

const preview = computed(() => previewMcpImport(json.value, props.existingNames));
const blocked = computed(
  () =>
    !preview.value || !!preview.value.error || preview.value.entries.some((e) => e.insecure || !e.transport),
);
const errorText = computed(() => serverError.value || preview.value?.error || '');

watch(json, () => {
  serverError.value = '';
});
watch(open, (value) => {
  if (!value) return;
  json.value = '';
  serverError.value = '';
  testAfterImport.value = true;
});

function insertExample(info: MenuInfo) {
  json.value = exampleText(String(info.key));
}
function entryTitle(entry: McpImportEntry) {
  if (!entry.transport) return '不支持的传输方式';
  if (entry.insecure) return '远程地址需使用 https://';
  if (entry.overwrite) return '已有同名服务，导入后会覆盖并重置为未启用';
  if (entry.transport === 'stdio') return '将以 Forge 服务进程权限运行，请确认来源可信';
  return undefined;
}
function entryLabel(entry: McpImportEntry) {
  const parts = [entry.name, entry.transport ? transportLabel(entry.transport) : '未知协议'];
  if (entry.insecure) parts.push('需 HTTPS');
  else if (entry.overwrite) parts.push('将覆盖');
  return parts.join(' · ');
}
function entryColor(entry: McpImportEntry) {
  if (!entry.transport || entry.insecure) return 'error';
  if (entry.overwrite) return 'warning';
  return undefined;
}

async function submit() {
  if (blocked.value || submitting.value) return;
  submitting.value = true;
  try {
    const result = await post<{ items: McpServer[] }>('/registry/mcp-servers/import', {
      config: JSON.parse(json.value),
    });
    open.value = false;
    emit('imported', result.items ?? [], testAfterImport.value);
  } catch (error) {
    // 弹窗保持打开，错误留在识别结果行，方便对照修改
    serverError.value = (error as Error).message;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <a-modal
    v-model:open="open"
    title="添加 MCP 服务"
    :width="600"
    centered
    destroy-on-close
    ok-text="确定"
    cancel-text="取消"
    wrap-class-name="mcp-import-modal"
    :confirm-loading="submitting"
    :ok-button-props="{ disabled: blocked }"
    :cancel-button-props="{ disabled: submitting }"
    @ok="submit"
  >
    <PanelSection icon="code" title="服务配置" hint="认证信息与 stdio 参数加密保存在本机，列表中不显示">
      <template #extra>
        <a-dropdown :trigger="['click']" placement="bottomRight">
          <a-button type="link" size="small" class="mcp-example-trigger">
            插入示例<Icon name="arrow-down-s-line" :size="14" />
          </a-button>
          <template #overlay>
            <a-menu :items="exampleMenu" @click="insertExample" />
          </template>
        </a-dropdown>
      </template>
      <a-textarea
        id="mcp-import-json"
        v-model:value="json"
        class="mcp-json-input"
        :rows="12"
        spellcheck="false"
        :placeholder="placeholder"
        aria-label="mcpServers 配置 JSON"
      />
      <div v-if="errorText || preview?.entries.length" class="mcp-import-status" aria-live="polite">
        <span v-if="errorText" class="mcp-import-error" role="alert">
          <Icon name="close-line" :size="14" />{{ errorText }}
        </span>
        <template v-else>
          <a-tooltip v-for="entry in preview?.entries" :key="entry.name" :title="entryTitle(entry)">
            <a-tag :bordered="false" :color="entryColor(entry)" class="mcp-import-entry">
              <Icon v-if="entry.transport === 'stdio'" name="shield" :size="12" /><span>{{
                entryLabel(entry)
              }}</span>
            </a-tag>
          </a-tooltip>
        </template>
      </div>
    </PanelSection>
    <PanelSection icon="settings" title="导入选项">
      <label class="mcp-import-option">
        <span>导入后测试连接</span>
        <a-switch v-model:checked="testAfterImport" />
      </label>
    </PanelSection>
  </a-modal>
</template>

<style scoped>
.mcp-example-trigger {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding-inline: 0;
}
.mcp-json-input {
  background: var(--surface-card);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 1.7;
}
.mcp-import-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}
.mcp-import-status :deep(.ant-tag) {
  margin: 0;
}
.mcp-import-entry {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.mcp-import-error {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--color-danger-text);
  font-size: 12px;
}
/* 覆盖 style.css 全局 label { display:block; margin:20px 0 8px }：选项行左文案右开关 */
.mcp-import-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0;
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 400;
  cursor: pointer;
}
</style>
