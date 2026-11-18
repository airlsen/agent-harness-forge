<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useConversation } from '../stores/conversation';
import { usePlatform } from '../stores/platform';
import { isAvailableScenario } from '../utils/presentation';
import { contextPressure, tokenLabel } from '../utils/modelContext';
import Icon from './ForgeIcon.vue';
import ModelPicker from './ModelPicker.vue';

const props = withDefaults(defineProps<{ hero?: boolean }>(), { hero: false });
const emit = defineEmits<{ submitted: [id: number]; capabilities: [] }>();
const app = usePlatform();
const chat = useConversation();
const router = useRouter();
const picker = ref(false);
const root = ref<HTMLElement | null>(null);
const textarea = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const modelPicker = ref<InstanceType<typeof ModelPicker> | null>(null);
const attaching = ref(false);
const submitting = ref(false);
/** 已有会话中待切换的目标模型（与当前模型不同）；下一条消息起生效。 */
const switchTarget = computed(() =>
  chat.current && chat.selectedModelId !== chat.current.modelId
    ? (app.modelOptions.find((option) => option.id === chat.selectedModelId) ?? null)
    : null,
);
const switchTight = computed(
  () => switchTarget.value && contextPressure(chat.current?.contextTokens, switchTarget.value.contextWindow),
);
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
function outside(event: PointerEvent) {
  if (root.value && !root.value.contains(event.target as Node)) picker.value = false;
}
onMounted(() => {
  document.addEventListener('pointerdown', outside);
  resize();
});
let active = true;
onBeforeUnmount(() => {
  active = false;
  document.removeEventListener('pointerdown', outside);
});

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
  <div ref="root" :class="['task-composer', { 'task-composer-hero': hero }]">
    <div v-if="switchTarget" class="model-switch-hint" role="status">
      <Icon name="cpu" :size="14" />
      <p>
        下一条消息起改用 <strong>{{ switchTarget.name }}</strong><template v-if="switchTight"
          >；当前对话约 {{ tokenLabel(chat.current?.contextTokens ?? 0) }} tokens，接近该模型
          {{ tokenLabel(switchTarget.contextWindow) }} 的上下文窗口，较早的内容会先被压缩为摘要</template
        >
      </p>
      <button
        type="button"
        class="button text small"
        :disabled="chat.running || chat.loading"
        @click="chat.selectModel(chat.current?.modelId ?? null)"
      >
        取消切换
      </button>
    </div>
    <div v-if="chat.draftAttachments.length" class="attachment-chips">
      <span v-for="(file, index) in chat.draftAttachments" :key="index">
        <Icon name="file" :size="14" />{{ file.name }}
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
      <div class="task-composer-options">
        <div class="scenario-picker-wrap">
          <button
            class="scenario-trigger"
            :disabled="Boolean(chat.current) || chat.running || chat.loading"
            :aria-expanded="picker"
            aria-label="选择场景"
            aria-controls="scenario-options"
            @click="
              picker = !picker;
              modelPicker?.close();
            "
            @keydown.esc.stop="picker = false"
          >
            <Icon
              :name="chat.current?.bundle?.meta?.scenarioIcon ?? selected?.payload.icon ?? 'sparkles'"
              :size="16"
            />
            <span>{{ chat.current?.scenarioName ?? selected?.payload.name ?? '选择场景' }}</span>
            <Icon v-if="!chat.current" name="chevronDown" :size="13" />
            <Icon v-else name="lock" :size="12" />
          </button>
          <div
            v-if="picker"
            id="scenario-options"
            class="scenario-popover"
            @keydown.esc.stop="picker = false"
          >
            <div class="popover-label">选择已发布场景或预置模板</div>
            <button
              v-for="scenario in choices"
              :key="scenario.id"
              :class="{ selected: selected?.id === scenario.id }"
              @click="
                chat.selectedScenarioId = scenario.id;
                chat.previewScenarioId = scenario.status === 'draft' ? scenario.id : null;
                picker = false;
                textarea?.focus();
              "
            >
              <Icon :name="scenario.payload.icon" :size="18" />
              <div>
                <strong
                  >{{ scenario.payload.name
                  }}<small v-if="scenario.status === 'draft'">草稿预览</small></strong
                ><span>{{ scenario.payload.description }}</span>
              </div>
              <Icon v-if="selected?.id === scenario.id" name="check" :size="15" />
            </button>
            <p v-if="!choices.length" class="popover-label">暂无可用场景</p>
            <RouterLink to="/agent/scenarios">浏览企业场景 <Icon name="arrow" :size="14" /></RouterLink>
          </div>
        </div>
        <ModelPicker ref="modelPicker" @opened="picker = false" @selected="textarea?.focus()" />
        <span class="composer-option-divider"></span>
        <button
          class="icon-button"
          :disabled="chat.running || attaching || chat.loading"
          aria-label="附加文本文件"
          title="附加文本文件 · 最多 4 个，每个 200 KB"
          @click="fileInput?.click()"
        >
          <span v-if="attaching" class="loader small"></span><Icon v-else name="paperclip" :size="18" />
        </button>
        <input
          ref="fileInput"
          type="file"
          multiple
          accept=".txt,.md,.csv,.json,.ts,.js,.py,.html,.css,.yaml,.yml,.sql,.xml,.log"
          hidden
          @change="attach"
        />
        <button
          v-if="!hero"
          class="composer-capabilities"
          title="查看本次会话的能力与边界"
          @click="emit('capabilities')"
        >
          <Icon name="blocks" :size="15" /><span>能力</span>
        </button>
      </div>
      <button
        v-if="chat.current?.status === 'running'"
        class="stop-button"
        @click="chat.interrupt().catch((e) => app.toast(e.message, 'error'))"
      >
        <span></span>中止
      </button>
      <button
        v-else
        class="task-send"
        :disabled="!canSend"
        aria-label="发送任务"
        title="发送任务 · Enter"
        @click="send"
      >
        <span v-if="submitting || chat.sending" class="loader small"></span
        ><template v-else><span v-if="hero">发送</span><Icon name="arrowUp" :size="18" /></template>
      </button>
    </div>
  </div>
  <div :class="['task-composer-footnote', { 'task-composer-shortcuts': hero }]">
    <span v-if="!hero"
      ><Icon name="layers" :size="12" />{{
        chat.current ? '场景与策略已锁定 · 模型可在两轮之间切换' : '新会话将使用所选场景与模型'
      }}</span
    >
    <span>Enter 发送 <i>·</i> Shift + Enter 换行</span>
  </div>
</template>
