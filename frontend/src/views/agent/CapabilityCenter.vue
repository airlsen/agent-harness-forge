<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api/client';
import { usePlatform } from '../../stores/platform';
import Icon from '../../components/ForgeIcon.vue';
const app = usePlatform(),
  tab = ref('plugins'),
  plugins = ref<any[]>([]),
  query = ref(''),
  detail = ref<any | null>(null);
const visiblePlugins = computed(() =>
  plugins.value.filter((p) => (p.name + p.description).toLowerCase().includes(query.value.toLowerCase())),
);
const visibleTools = computed(() =>
  app.tools.filter((p) =>
    (p.name + p.title + p.description).toLowerCase().includes(query.value.toLowerCase()),
  ),
);
onMounted(async () => {
  try {
    plugins.value = (await api('/registry/plugins')).items;
  } catch (e) {
    app.toast((e as Error).message, 'error');
  }
});
</script>
<template>
  <main class="page-content">
    <div class="page-heading">
      <div>
        <div class="eyebrow">CAPABILITIES</div>
        <h1>能力中心</h1>
        <p>模型之外，真正让 Agent 能做事的工具与插件。</p>
      </div>
      <span class="tag soft"><Icon name="shield" :size="13" />白名单装配</span>
    </div>
    <div class="capability-summary">
      <div>
        <span class="metric-icon"><Icon name="blocks" :size="20" /></span><strong>{{ plugins.length }}</strong
        ><span>已登记组件</span>
      </div>
      <div>
        <span class="metric-icon"><Icon name="wrench" :size="20" /></span
        ><strong>{{ app.tools.length }}</strong
        ><span>已接入工具</span>
      </div>
      <div>
        <span class="metric-icon"><Icon name="shield" :size="20" /></span><strong>会话级</strong
        ><span>文件访问范围</span>
      </div>
      <div>
        <span class="metric-icon"><Icon name="lock" :size="20" /></span><strong>默认拒绝</strong
        ><span>未授权工具</span>
      </div>
    </div>
    <div class="collection-toolbar">
      <div class="collection-tabs">
        <button
          v-for="item in [
            { id: 'plugins', label: '插件组件', count: plugins.length },
            { id: 'tools', label: '内置工具', count: app.tools.length },
            { id: 'skills', label: 'Skill 库', count: 0 },
            { id: 'mcp', label: 'MCP 服务', count: 0 },
          ]"
          :key="item.id"
          :class="{ selected: tab === item.id }"
          @click="tab = item.id"
        >
          {{ item.label }}<span>{{ item.count }}</span>
        </button>
      </div>
      <label v-if="tab === 'plugins' || tab === 'tools'" class="search-field"
        ><Icon name="search" :size="17" /><input v-model="query" placeholder="搜索能力" aria-label="搜索能力"
      /></label>
    </div>
    <div v-if="tab === 'plugins'" class="plugin-grid">
      <article v-for="plugin in visiblePlugins" :key="plugin.name" class="plugin-card">
        <div class="plugin-card-top">
          <span :class="['scene-icon', plugin.type === 'kernel' ? 'code' : 'sparkles']"
            ><Icon :name="plugin.type === 'kernel' ? 'box' : 'blocks'" :size="25" /></span
          ><span class="tag success">{{ plugin.type === 'kernel' ? '已安装' : '可装配' }}</span>
        </div>
        <h2>{{ plugin.name === 'dsh-sdk' ? 'DeepSeek Harness' : 'Forge Runtime' }}</h2>
        <code>{{ plugin.package }}</code>
        <p>{{ plugin.description }}</p>
        <div class="plugin-extension-points">
          <span v-for="point in plugin.extensionPoints" :key="point">{{ point }}</span>
        </div>
        <footer>
          <span>v{{ plugin.version }}</span
          ><button @click="detail = plugin">组件详情 <Icon name="arrow" :size="14" /></button>
        </footer>
      </article>
      <div v-if="!visiblePlugins.length" class="empty-state"><h3>没有匹配的组件</h3></div>
    </div>
    <div v-else-if="tab === 'tools'" class="tools-list">
      <article v-for="tool in visibleTools" :key="tool.name">
        <span class="scene-icon"><Icon :name="tool.icon" :size="22" /></span>
        <div>
          <h2>
            {{ tool.title }}<code>{{ tool.name }}</code>
          </h2>
          <p>{{ tool.description }}</p>
        </div>
        <span :class="['tag', tool.permission === 'approval' ? 'warm' : 'soft']"
          ><Icon :name="tool.permission === 'approval' ? 'shield' : 'eye'" :size="12" />{{
            tool.permission === 'approval' ? '默认需审批' : '只读'
          }}</span
        >
      </article>
    </div>
    <div v-else class="empty-state capability-unavailable">
      <span class="empty-emblem"><Icon :name="tab === 'skills' ? 'book' : 'plug'" :size="32" /></span
      ><span class="tag neutral">尚未接入</span>
      <h3>{{ tab === 'skills' ? '把团队的方法，沉淀为 Skill' : '连接你的企业工具与数据' }}</h3>
      <p>
        {{
          tab === 'skills'
            ? 'Skill 的登记、版本管理与物化执行将在后续版本接入。当前没有可挂载的 Skill。'
            : 'MCP 服务注册、认证托管与运行时挂载将在后续版本接入。当前没有已连接的 MCP 服务。'
        }}
      </p>
      <RouterLink to="/agent/scenarios" class="button secondary"
        >先装配现有能力 <Icon name="arrow" :size="15"
      /></RouterLink>
    </div>
    <div class="page-note">
      <Icon name="info" :size="14" />工具是否可执行，由场景授权与治理策略共同决定；当前部署不开放任意 Shell
      或外部插件安装。
    </div>
    <div v-if="detail" class="drawer-backdrop" @click.self="detail = null">
      <section class="drawer" role="dialog" aria-modal="true" aria-label="组件详情">
        <header>
          <div>
            <h2>{{ detail.name }}</h2>
            <p>{{ detail.package }}</p>
          </div>
          <button class="icon-button" aria-label="关闭组件详情" @click="detail = null">
            <Icon name="close" :size="20" />
          </button>
        </header>
        <div class="drawer-body">
          <div class="detail-block">
            <h3>组件说明</h3>
            <p>{{ detail.description }}</p>
          </div>
          <div class="detail-block">
            <h3>版本</h3>
            <code>{{ detail.version }}</code>
          </div>
          <div class="detail-block">
            <h3>扩展点</h3>
            <div class="chip-list">
              <span v-for="point in detail.extensionPoints" :key="point" class="tag soft">{{ point }}</span>
            </div>
          </div>
          <div class="detail-block">
            <h3>权限范围</h3>
            <div class="chip-list">
              <span v-for="point in detail.permissions" :key="point" class="tag warm">{{ point }}</span>
            </div>
          </div>
          <div class="form-alert">
            <Icon name="shield" :size="17" /><span
              >本页是已登记、随部署安装的能力目录，不是开放式社区插件市场。</span
            >
          </div>
        </div>
      </section>
    </div>
  </main>
</template>
