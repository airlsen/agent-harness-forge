<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type VNode } from 'vue';
import { useRouter } from 'vue-router';
import { useConversation } from '../../stores/conversation';
import { usePlatform } from '../../stores/platform';
import { isAvailableScenario } from '../../utils/presentation';
import Icon from '../base/ForgeIcon.vue';
import ModelPicker from './ModelPicker.vue';
import CodePicker from './CodePicker.vue';
import CapabilityPicker from './CapabilityPicker.vue';

const props = withDefaults(defineProps<{ hero?: boolean }>(), { hero: false });
const emit = defineEmits<{ submitted: [id: number] }>();
const app = usePlatform();
const chat = useConversation();
const router = useRouter();
const picker = ref(false);
const textarea = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const modelPicker = ref<InstanceType<typeof ModelPicker> | null>(null);
const codePicker = ref<InstanceType<typeof CodePicker> | null>(null);
const capabilityPicker = ref<InstanceType<typeof CapabilityPicker> | null>(null);
const attaching = ref(false);
const submitting = ref(false);
const selected = computed(
  () => app.scenarios.find((s) => s.id === chat.selectedScenarioId) ?? app.availableScenarios[0],
);
const choices = computed(() =>
  app.scenarios.filter((s) => isAvailableScenario(s) || s.id === chat.selectedScenarioId),
);
const canSend = computed(
  () =>
    (chat.input.trim() || chat.draftAttachments.length) &&
    !attaching.value &&
    !submitting.value &&
    !chat.running &&
    !chat.loading,
);
const SelectMenu = (props: { node: VNode }) => props.node;

function resize() {
  const node = textarea.value;
  if (!node) return;
  node.style.height = 'auto';
  node.style.height = `${Math.min(node.scrollHeight, props.hero ? 230 : 180)}px`;
}
watch(
  () => chat.input,
  () => nextTick(resize),
);
onMounted(() => {
  resize();
});
let active = true;
onBeforeUnmount(() => {
  active = false;
});
function chooseScenario(value: unknown) {
  if (typeof value !== 'number') return;
  const id = value;
  chat.selectedScenarioId = id;
  chat.previewScenarioId =
    choices.value.find((scenario) => scenario.id === id)?.status === 'draft' ? id : null;
  picker.value = false;
  void nextTick(() => textarea.value?.focus());
}
function scenarioOpen(open: boolean) {
  picker.value = open;
  if (open) {
    modelPicker.value?.close();
    codePicker.value?.close();
    capabilityPicker.value?.close();
  }
}

async function send() {
  if (!canSend.value || chat.running) return;
  // 已有会话使用创建时锁定的模型快照；只有新会话需要一个当前可用的模型。
  if (!chat.current && !app.modelOptions.length) {
    app.toast('尚无可用模型，请由管理员在「模型管理」添加并启用模型', 'info');
    await router.push('/agent/models');
    return;
  }
  submitting.value = true;
  picker.value = false;
  try {
    const id = await chat.submit();
    if (id && active) emit('submitted', id);
  } catch (error) {
    app.toast((error as Error).message, 'error');
  } finally {
    submitting.value = false;
  }
}
async function attach(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!input.files) return;
  const revision = chat.draftRevision;
  attaching.value = true;
  try {
    for (const file of Array.from(input.files)) {
      if (file.size > 200000) {
        app.toast(`${file.name} 超过 200 KB，请精简后附加`, 'error');
        continue;
      }
      if (chat.draftAttachments.length >= 4) {
        app.toast('每轮最多附加 4 个文本文件', 'info');
        break;
      }
      const content = await file.text();
      if (!active || chat.draftRevision !== revision) break;
      if (content.includes('\u0000')) {
        app.toast(`${file.name} 不是可读取的文本文件`, 'error');
        continue;
      }
      chat.draftAttachments.push({ name: file.name, content });
    }
  } catch {
    app.toast('未能读取附件，请重新选择文本文件', 'error');
  } finally {
    input.value = '';
    attaching.value = false;
  }
}
function keyboard(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
}
defineExpose({ focus: () => textarea.value?.focus() });
</script>
<template>
  <div :class="['task-composer', { 'task-composer-hero': hero }]">
    <div v-if="chat.draftAttachments.length" class="attachment-chips">
      <span v-for="(file, index) in chat.draftAttachments" :key="index" :title="file.name">
        <Icon name="file" :size="14" /><span class="attachment-name">{{ file.name }}</span>
        <button
          :aria-label="`移除附件 ${file.name}`"
          :disabled="chat.running"
          @click="chat.draftAttachments.splice(index, 1)"
        >
          <Icon name="close" :size="13" />
        </button>
      </span>
    </div>
    <textarea
      id="task-input"
      ref="textarea"
      v-model="chat.input"
      aria-label="任务输入"
      :placeholder="chat.current ? '补充要求，或继续这项工作…' : '描述你的目标、已有信息和期望结果…'"
      :disabled="chat.running || chat.loading"
      :rows="hero ? 3 : 2"
      maxlength="64000"
      @keydown="keyboard"
    ></textarea>
    <div class="task-composer-toolbar">
      <div class="task-composer-options" role="group" aria-label="任务配置，可横向滚动">
        <div class="scenario-picker-wrap">
          <Icon
            v-if="!chat.current"
            class="scenario-select-icon"
            :name="selected?.payload.icon ?? 'sparkles'"
            :size="16"
          />
          <a-select
            v-if="!chat.current"
            class="scenario-select"
            :value="chat.selectedScenarioId ?? selected?.id"
            :disabled="chat.running || chat.loading"
            aria-label="选择场景"
            :open="picker"
            popup-class-name="task-select-popup scenario-select-popup"
            option-label-prop="label"
            :show-search="false"
            @dropdown-visible-change="scenarioOpen"
            @change="chooseScenario"
          >
            <a-select-option
              v-for="scenario in choices"
              :key="scenario.id"
              :value="scenario.id"
              :label="scenario.payload.name"
            >
              <Icon :name="scenario.payload.icon" :size="18" />
              <span class="task-select-option-copy">
                <strong
                  >{{ scenario.payload.name
                  }}<small v-if="scenario.status === 'draft'">草稿预览</small></strong
                ><span>{{ scenario.payload.description }}</span>
              </span>
            </a-select-option>
            <template #dropdownRender="{ menuNode }">
              <SelectMenu :node="menuNode" />
              <RouterLink class="task-select-footer" to="/agent/scenarios" @click="picker = false"
                >浏览企业场景 <Icon name="arrow" :size="14"
              /></RouterLink>
            </template>
          </a-select>
          <button v-else class="scenario-trigger" disabled aria-label="当前会话场景已锁定">
            <Icon :name="chat.current.bundle?.meta?.scenarioIcon ?? 'sparkles'" :size="16" />
            <span>{{ chat.current.scenarioName }}</span>
            <Icon name="lock" :size="12" />
          </button>
        </div>
        <ModelPicker
          ref="modelPicker"
          @opened="
            picker = false;
            codePicker?.close();
            capabilityPicker?.close();
          "
          @selected="textarea?.focus()"
        />
        <CodePicker
          ref="codePicker"
          @opened="
            picker = false;
            modelPicker?.close();
            capabilityPicker?.close();
          "
        />
        <CapabilityPicker
          ref="capabilityPicker"
          @opened="
            picker = false;
            modelPicker?.close();
            codePicker?.close();
          "
        />
      </div>
      <a-button
        type="text"
        class="icon-button composer-attachment"
        :disabled="chat.running || chat.loading"
        :loading="attaching"
        aria-label="附加文本文件"
        title="附加文本文件 · 最多 4 个，每个 200 KB"
        @click="fileInput?.click()"
      >
        <Icon v-if="!attaching" name="paperclip" :size="18" />
      </a-button>
      <input
        ref="fileInput"
        type="file"
        multiple
        accept=".txt,.md,.csv,.json,.ts,.js,.py,.html,.css,.yaml,.yml,.sql,.xml,.log"
        hidden
        @change="attach"
      />
      <button
        v-if="chat.current?.status === 'running'"
        type="button"
        class="stop-button"
        aria-label="中止执行"
        title="中止执行"
        @click="chat.interrupt().catch((e) => app.toast(e.message, 'error'))"
      >
        <span aria-hidden="true"></span>
      </button>
      <a-button
        v-else
        type="primary"
        class="task-send"
        shape="circle"
        :disabled="!canSend && !submitting && !chat.sending"
        :loading="submitting || chat.sending"
        aria-label="发送任务"
        title="发送任务 · Enter"
        @click="send"
      >
        <Icon v-if="!submitting && !chat.sending" name="ri-arrow-up-line" :size="18" />
      </a-button>
    </div>
  </div>
  <div v-if="!hero" class="task-composer-footnote">
    <span
      ><Icon name="layers" :size="12" />{{
        chat.current ? '场景与策略已锁定 · 模型可在两轮之间切换' : '新会话将使用所选场景与模型'
      }}</span
    >
  </div>
</template>
