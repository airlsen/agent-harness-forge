<script setup lang="ts">
/**
 * AgentChat 工作台主页面（ClaudeChat.vue 平移目标壳）。
 * 布局：左 消息流 / 右 Tab(产物 | 轨迹TrajectoryPanel) / 底 输入区(场景选择器 + 成本条)。
 * W1–W4 排期见 docs/04-前端架构分析.md §六。
 */
import { useAgentChatStore } from '../../stores/agentChat'

const store = useAgentChatStore()
</script>

<template>
  <div class="agent-chat">
    <header class="agent-chat__header">
      <span>AgentHarness Forge · 工作台</span>
      <el-tag v-if="store.currentScenario" size="small">
        {{ store.currentScenario.payload.name }} · v{{ store.currentScenario.current_version }}
      </el-tag>
    </header>

    <main class="agent-chat__main">
      <!-- TODO(W2): 消息流渲染 + ToolCallCard + SubagentCard + ApprovalDialog -->
      <el-empty description="选择场景或输入任务开始（M1 联调）" />
    </main>

    <footer class="agent-chat__input">
      <!-- TODO(W3): ScenarioSelect（三级分组） + prompt 模板回填 -->
      <el-input
        type="textarea"
        :rows="3"
        placeholder="描述你的任务…"
        :disabled="!store.canSubmit"
        @keyup.ctrl.enter="store.submit('')"
      />
      <div class="agent-chat__cost">本轮成本 ¥{{ store.cost.cost.toFixed(4) }}</div>
    </footer>
  </div>
</template>

<style scoped>
.agent-chat {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.agent-chat__main {
  flex: 1;
  overflow: auto;
  padding: 16px;
}
.agent-chat__input {
  border-top: 1px solid var(--el-border-color);
  padding: 12px 16px;
}
.agent-chat__cost {
  margin-top: 6px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
