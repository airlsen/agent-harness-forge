<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { usePlatform } from '../stores/platform';
import { useConversation } from '../stores/conversation';
import type { Scenario } from '../types/platform';
import Icon from './ForgeIcon.vue';
import TaskComposer from './TaskComposer.vue';

const emit = defineEmits<{ submitted: [id: number] }>();
const app = usePlatform();
const chat = useConversation();
const composer = ref<InstanceType<typeof TaskComposer> | null>(null);
const selected = computed(() => app.scenarios.find((scenario) => scenario.id === chat.selectedScenarioId));
const suggestions = computed(() =>
  app.availableScenarios.filter((scenario) => scenario.id !== app.availableScenarios[0]?.id).slice(0, 3),
);
async function chooseScenario(scenario: Scenario) {
  if (!chat.selectScenario(scenario.id)) return;
  // Selecting a work style is not starting another conversation or replacing the user's words.
  await nextTick();
  composer.value?.focus();
}
</script>
<template>
  <section class="conversation-start-surface" aria-labelledby="conversation-start-title">
    <div class="conversation-start-inner">
      <header class="conversation-start-heading">
        <p v-if="selected?.status === 'draft'" class="start-draft-notice" role="status">
          <Icon name="edit" :size="14" />维护草稿预览 · {{ selected.payload.name }}
        </p>
        <h1 id="conversation-start-title">今天要完成什么工作？</h1>
      </header>
      <div class="conversation-start-composer">
        <TaskComposer ref="composer" hero @submitted="(id) => emit('submitted', id)" />
        <div
          v-if="!app.modelOptions.length && !app.loading"
          class="connect-model-prompt enterprise-model-prompt"
          role="status"
        >
          <Icon name="plug" :size="17" />
          <div><strong>尚无可用模型</strong><span>管理员添加并启用模型后，即可开始真实执行。</span></div>
          <RouterLink to="/agent/models">配置连接 <Icon name="arrow" :size="14" /></RouterLink>
        </div>
      </div>
      <div
        v-if="suggestions.length"
        class="conversation-start-suggestions"
        role="group"
        aria-label="快捷选择场景"
      >
        <button
          v-for="scenario in suggestions"
          :key="scenario.id"
          class="conversation-scenario-chip"
          :aria-label="`使用场景 ${scenario.payload.name}`"
          :title="scenario.payload.name"
          :aria-pressed="chat.selectedScenarioId === scenario.id"
          :disabled="chat.running || chat.loading || Boolean(chat.current)"
          @click="chooseScenario(scenario)"
        >
          <Icon :name="scenario.payload.icon" :size="16" /><span>{{ scenario.payload.name }}</span>
        </button>
      </div>
      <p v-else-if="app.loading" class="conversation-start-status" role="status">正在读取可用场景…</p>
      <p v-else-if="!selected" class="conversation-start-status" role="status">
        暂无可用场景，<RouterLink to="/agent/scenarios">前往企业场景查看</RouterLink>。
      </p>
    </div>
  </section>
</template>
