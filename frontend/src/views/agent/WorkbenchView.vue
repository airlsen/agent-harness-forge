<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { usePlatform } from '../../stores/platform';
import { useConversation } from '../../stores/conversation';
import { formatDate, sessionState } from '../../utils/presentation';
import Icon from '../../components/ForgeIcon.vue';
import TaskComposer from '../../components/TaskComposer.vue';
import type { Scenario } from '../../types/platform';

const app = usePlatform();
const chat = useConversation();
const router = useRouter();
const scenarios = computed(() => app.availableScenarios.slice(0, 4));
const recent = computed(() => app.regularConversations.slice(0, 3));
onMounted(() => {
  if (chat.current || app.scenarios.find((s) => s.id === chat.selectedScenarioId)?.status === 'draft')
    chat.newConversation();
  void app.refreshSessions().catch((error) => app.toast(error.message, 'error'));
});
function useScenario(scenario: Scenario) {
  chat.newConversation(scenario.id);
  void router.push('/agent/chat');
}
function focusComposer() {
  document.getElementById('task-input')?.focus();
}
</script>
<template>
  <main class="enterprise-page workbench-page">
    <div class="workbench-inner">
      <section class="workbench-hero" aria-labelledby="workbench-title">
        <div class="workbench-hero-copy">
          <div class="workbench-kicker"><span></span>ENTERPRISE INTELLIGENCE, IN ACTION</div>
          <h1 id="workbench-title">从一个目标，<span>开始今天的工作。</span></h1>
          <p>发现企业共享的场景与能力，在会话中把工作向前推进。</p>
        </div>
        <div class="workbench-orbit" aria-hidden="true">
          <i class="orbit-line"></i><i class="orbit-line second"></i
          ><span class="orbit-core"><Icon name="sparkles" :size="30" /></span
          ><span class="orbit-satellite first"><Icon name="book" :size="16" /></span
          ><span class="orbit-satellite second"><Icon name="plug" :size="16" /></span
          ><span class="orbit-satellite third"><Icon name="file" :size="16" /></span
          ><span class="orbit-dot"></span>
        </div>
      </section>
      <section class="workbench-start" aria-label="开始一项工作">
        <TaskComposer hero @submitted="(id) => router.push(`/agent/chat/${id}`)" />
        <div
          v-if="!app.connection?.configured && !app.loading"
          class="connect-model-prompt enterprise-model-prompt"
        >
          <Icon name="plug" :size="17" />
          <div><strong>模型尚未连接</strong><span>管理员完成配置后，即可开始真实执行。</span></div>
          <RouterLink to="/agent/models">配置连接 <Icon name="arrow" :size="14" /></RouterLink>
        </div>
      </section>
      <section class="workbench-section" aria-labelledby="recommended-scenes">
        <div class="workbench-section-heading">
          <div>
            <h2 id="recommended-scenes">从企业场景开始</h2>
            <span>已准备好的工作方式，直接复用。</span>
          </div>
          <RouterLink to="/agent/scenarios">全部场景 <Icon name="arrow" :size="14" /></RouterLink>
        </div>
        <div v-if="app.loading" class="workbench-scene-grid" aria-busy="true">
          <div v-for="n in 4" :key="n" class="scene-skeleton"></div>
        </div>
        <div v-else-if="scenarios.length" class="workbench-scene-grid">
          <button
            v-for="scenario in scenarios"
            :key="scenario.id"
            class="workbench-scene-card"
            :aria-label="`使用场景 ${scenario.payload.name}`"
            @click="useScenario(scenario)"
          >
            <div>
              <span :class="['scene-icon', scenario.payload.icon]"
                ><Icon :name="scenario.payload.icon" :size="21" /></span
              ><Icon class="scene-card-arrow" name="arrow" :size="16" />
            </div>
            <h3>{{ scenario.payload.name }}</h3>
            <p>{{ scenario.payload.description || '使用预配置的提示词与工具，开始一项工作。' }}</p>
            <small
              >{{ scenario.space === 'official' ? '平台预置' : '已发布' }}<i>·</i>v{{
                scenario.current_version
              }}</small
            >
          </button>
        </div>
        <div v-else class="inline-empty">
          <Icon name="grid" :size="23" />
          <div>
            <strong>暂无可使用的场景</strong>
            <p>由管理员创建并发布场景后，会出现在这里。</p>
          </div>
          <RouterLink class="button secondary small" to="/agent/scenarios">查看目录</RouterLink>
        </div>
      </section>
      <section class="workbench-section workbench-abilities" aria-labelledby="company-abilities">
        <div class="workbench-section-heading">
          <div>
            <h2 id="company-abilities">企业公共能力</h2>
            <span>统一接入、共同复用，无需重复安装。</span>
          </div>
          <RouterLink to="/agent/capabilities">能力中心 <Icon name="arrow" :size="14" /></RouterLink>
        </div>
        <div class="workbench-ability-grid">
          <RouterLink to="/agent/capabilities?tab=tools" class="workbench-ability-item"
            ><span class="ability-mini-icon tools"><Icon name="wrench" :size="20" /></span>
            <div>
              <strong>基础工具 <span class="availability-dot"></span></strong>
              <p>{{ app.tools.length }} 项已接入 · 按场景授权使用</p>
            </div>
            <Icon name="chevron" :size="15"
          /></RouterLink>
          <RouterLink to="/agent/capabilities?tab=skills" class="workbench-ability-item"
            ><span class="ability-mini-icon skills"><Icon name="book" :size="20" /></span>
            <div>
              <strong>Skills 技能 <small>尚未接入</small></strong>
              <p>企业可复用的工作规范与步骤</p>
            </div>
            <Icon name="chevron" :size="15"
          /></RouterLink>
          <RouterLink to="/agent/capabilities?tab=mcp" class="workbench-ability-item"
            ><span class="ability-mini-icon mcp"><Icon name="plug" :size="20" /></span>
            <div>
              <strong>MCP 服务 <small>尚未接入</small></strong>
              <p>连接企业业务系统与数据</p>
            </div>
            <Icon name="chevron" :size="15"
          /></RouterLink>
        </div>
      </section>
      <section class="workbench-section workbench-recent" aria-labelledby="continue-work">
        <div class="workbench-section-heading">
          <div>
            <h2 id="continue-work">继续最近的工作</h2>
            <span>从会话记录中接着推进。</span>
          </div>
          <RouterLink to="/agent/conversations">全部会话 <Icon name="arrow" :size="14" /></RouterLink>
        </div>
        <div v-if="!recent.length" class="workbench-no-recent">
          <span class="recent-empty-icon"><Icon name="message" :size="21" /></span>
          <div>
            <strong>还没有会话，开始你的第一项工作。</strong>
            <p>执行后的对话与文件会在会话中保留，随时回来继续。</p>
          </div>
          <button @click="focusComposer">开始工作 <Icon name="arrowUp" :size="14" /></button>
        </div>
        <div v-else class="workbench-recent-list">
          <RouterLink v-for="item in recent" :key="item.id" :to="`/agent/chat/${item.id}`"
            ><span class="recent-list-icon"><Icon :name="sessionState(item.status).icon" :size="17" /></span>
            <div>
              <strong>{{ item.title }}</strong><small
                >{{ item.scenarioName }}<i>·</i>{{ formatDate(item.createdAt) }}</small
              >
            </div>
            <span :class="['session-state', sessionState(item.status).tone]"
              ><span></span>{{ sessionState(item.status).label }}</span
            ><Icon name="arrow" :size="15"
          /></RouterLink>
        </div>
      </section>
      <footer class="workbench-footer">
        <span class="footer-brand-mark"><Icon name="layers" :size="13" />FORGE</span
        ><span>企业能力共同复用 · 会话按需引用</span>
      </footer>
    </div>
  </main>
</template>
