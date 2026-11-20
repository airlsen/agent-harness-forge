<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../../../api/client';
import Icon from '../../../components/ForgeIcon.vue';
import CatalogCard from '../../../components/catalog/CatalogCard.vue';
import CatalogEmpty from '../../../components/catalog/CatalogEmpty.vue';
import CatalogFilter from '../../../components/catalog/CatalogFilter.vue';
import CatalogGrid from '../../../components/catalog/CatalogGrid.vue';
import CatalogSearch from '../../../components/catalog/CatalogSearch.vue';
import type { SkillSummary } from '../../../types/skill';

const skills = ref<SkillSummary[]>([]);
const query = ref('');
const status = ref<'all' | 'draft' | 'published'>('all');
const loading = ref(true);
const error = ref('');

const visibleSkills = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  return skills.value.filter((item) => {
    const matchesStatus = status.value === 'all' || item.status === status.value;
    const matchesQuery = !keyword || `${item.name} ${item.description}`.toLowerCase().includes(keyword);
    return matchesStatus && matchesQuery;
  });
});
const publishedCount = computed(() => skills.value.filter((item) => item.status === 'published').length);
const statusOptions = computed(() => [
  { value: 'all' as const, label: '全部', count: skills.value.length },
  { value: 'draft' as const, label: '草稿', count: skills.value.length - publishedCount.value },
  { value: 'published' as const, label: '已发布', count: publishedCount.value },
]);

function formatUpdatedAt(value: string | null) {
  if (!value) return '刚刚创建';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '最近更新';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
function clearFilters() {
  query.value = '';
  status.value = 'all';
}
async function load() {
  loading.value = true;
  error.value = '';
  try {
    skills.value = (await api<{ items: SkillSummary[] }>('/skills')).items;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <main class="page-content enterprise-page skill-library-page">
    <div class="enterprise-page-inner skill-library-inner">
      <div class="page-heading catalog-page-heading skill-library-heading">
        <div class="catalog-heading-copy">
          <span class="catalog-kicker"
            ><span class="catalog-kicker-mark"><Icon name="book" :size="12" /></span>SKILL LIBRARY</span
          >
          <h1>我的技能</h1>
          <p>管理可复用的工作方法。</p>
        </div>
      </div>

      <div v-if="loading" class="loading-inline" role="status"><a-spin size="small" />正在读取技能…</div>
      <a-alert
        v-else-if="error"
        class="skill-alert"
        type="error"
        show-icon
        message="技能列表未能读取"
        :description="error"
      >
        <template #action><a-button size="small" @click="load">重试</a-button></template>
      </a-alert>
      <template v-else>
        <div class="collection-toolbar enterprise-collection-toolbar skill-library-toolbar">
          <CatalogFilter v-model:value="status" :options="statusOptions" aria-label="按状态筛选" />
          <div class="skill-library-actions">
            <CatalogSearch v-model:value="query" placeholder="搜索技能名称或说明" aria-label="搜索技能" />
            <RouterLink v-slot="{ href, navigate }" to="/agent/skills/new" custom>
              <a-button type="primary" :href="href" @click="navigate">
                <template #icon><Icon name="plus" :size="16" /></template>新建技能
              </a-button>
            </RouterLink>
          </div>
        </div>
        <CatalogEmpty
          v-if="!skills.length"
          icon="book"
          title="还没有技能"
          description="定义一套可重复使用的工作方法。"
        />
        <template v-else>
          <CatalogGrid v-if="visibleSkills.length" aria-label="技能列表">
            <CatalogCard
              v-for="item in visibleSkills"
              :key="item.id"
              class="skill-card"
              :title="item.name"
              icon="book"
              tone="book"
              :description="item.description"
              placeholder="尚未添加用途说明。"
              :status="item.status === 'published' ? `已发布 · v${item.publishedVersion}` : '草稿'"
              :status-color="item.status === 'published' ? 'success' : undefined"
            >
              <template #sub>
                <span>修订 r{{ item.revision ?? 1 }}</span
                ><span>{{ formatUpdatedAt(item.updatedAt) }}</span>
              </template>
              <template #footer>
                <RouterLink v-slot="{ href, navigate }" :to="`/agent/skills/${item.id}`" custom>
                  <a-button
                    type="primary"
                    size="small"
                    :href="href"
                    :aria-label="`编辑技能：${item.name}`"
                    @click="navigate"
                  >
                    <template #icon><Icon name="edit" :size="14" /></template>编辑
                  </a-button>
                </RouterLink>
              </template>
            </CatalogCard>
          </CatalogGrid>
          <CatalogEmpty
            v-else
            icon="search"
            title="没有匹配的技能"
            description="试试更换筛选条件，或清除关键词。"
          >
            <a-button @click="clearFilters">清除筛选</a-button>
          </CatalogEmpty>
        </template>
      </template>
    </div>
  </main>
</template>

<style scoped>
.skill-library-inner {
  max-width: 1340px;
}
/* 页面节奏与企业场景 / 技能管理一致：页头、工具栏、内容间距 24px */
.skill-library-page .skill-library-heading {
  gap: 16px;
  margin-bottom: 24px;
}
.skill-library-actions :deep(.ant-btn) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.skill-library-page .enterprise-collection-toolbar.skill-library-toolbar {
  min-height: 32px;
  margin-bottom: 24px;
  padding: 0;
  border: 0;
}
.skill-library-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  min-width: 0;
}
.skill-library-actions > .ant-btn {
  flex-shrink: 0;
}
.skill-alert {
  margin-bottom: 24px;
}
@media (max-width: 700px) {
  .skill-library-actions {
    width: 100%;
    flex-wrap: wrap;
  }
  .skill-library-page .enterprise-collection-toolbar.skill-library-toolbar {
    flex-wrap: wrap;
    align-items: stretch;
    gap: 12px;
  }
}
</style>
