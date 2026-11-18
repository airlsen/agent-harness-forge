<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api/client';
import Icon from '../../components/ForgeIcon.vue';
import type { SkillSummary } from '../../types/skill';

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
      <header class="page-heading skill-library-heading">
        <div>
          <p class="eyebrow">企业能力中心</p>
          <h1>Skill 库</h1>
          <p>管理可复用的工作方法；草稿经确认后才会发布为正式版本。</p>
        </div>
        <div class="page-heading-actions">
          <span v-if="skills.length" class="heading-count">{{ skills.length }} 个 Skill</span>
          <RouterLink to="/agent/skills/new" class="button primary"
            ><Icon name="plus" :size="16" />新建 Skill</RouterLink
          >
        </div>
      </header>

      <section v-if="loading" class="skill-loading" aria-live="polite">
        <span class="loader"></span>正在读取 Skill 库…
      </section>
      <section v-else-if="error" class="form-alert error skill-alert" role="alert">
        <Icon name="info" :size="18" />
        <div>
          <strong>Skill 库未能读取</strong>
          <p>{{ error }}</p>
        </div>
        <button class="button secondary small" @click="load">重试</button>
      </section>
      <template v-else>
        <section v-if="!skills.length" class="enterprise-empty skill-library-empty">
          <span class="enterprise-empty-symbol"><Icon name="book" :size="29" /></span>
          <h2>还没有 Skill</h2>
          <p>从一项常用工作开始，定义目标、步骤和输出要求；创建后可以让助手协助完善草稿。</p>
          <RouterLink to="/agent/skills/new" class="button primary"
            ><Icon name="plus" :size="16" />创建第一个 Skill</RouterLink
          >
        </section>
        <template v-else>
          <section class="skill-library-toolbar" aria-label="Skill 筛选">
            <div class="skill-status-filters" role="group" aria-label="按状态筛选">
              <button :class="{ selected: status === 'all' }" @click="status = 'all'">
                全部 <span>{{ skills.length }}</span>
              </button>
              <button :class="{ selected: status === 'draft' }" @click="status = 'draft'">
                草稿 <span>{{ skills.length - publishedCount }}</span>
              </button>
              <button :class="{ selected: status === 'published' }" @click="status = 'published'">
                已发布 <span>{{ publishedCount }}</span>
              </button>
            </div>
            <label class="search-field skill-library-search"
              ><Icon name="search" :size="17" /><input
                v-model="query"
                placeholder="搜索名称或用途"
                aria-label="搜索 Skill"
            /></label>
          </section>
          <section v-if="visibleSkills.length" class="skill-library-grid" aria-label="Skill 列表">
            <RouterLink
              v-for="item in visibleSkills"
              :key="item.id"
              :to="`/agent/skills/${item.id}`"
              class="skill-library-card"
              :aria-label="`编辑 Skill：${item.name}`"
            >
              <div class="skill-library-card-top">
                <span class="skill-library-icon"><Icon name="book" :size="19" /></span>
                <span :class="['tag', item.status === 'published' ? 'success' : 'neutral']">{{
                  item.status === 'published' ? `已发布 · v${item.publishedVersion}` : '草稿'
                }}</span>
              </div>
              <div class="skill-library-card-copy">
                <h2>{{ item.name }}</h2>
                <p>{{ item.description || '尚未添加用途说明。' }}</p>
              </div>
              <footer>
                <span>修订 r{{ item.revision ?? 1 }} · {{ formatUpdatedAt(item.updatedAt) }}</span
                ><span class="skill-open-link">打开工作台 <Icon name="arrow" :size="14" /></span>
              </footer>
            </RouterLink>
          </section>
          <section v-else class="inline-empty skill-filter-empty">
            <Icon name="search" :size="22" />
            <div>
              <strong>没有匹配的 Skill</strong>
              <p>试试更换状态筛选或清除搜索关键词。</p>
            </div>
            <button
              class="button secondary small"
              @click="
                query = '';
                status = 'all';
              "
            >
              清除筛选
            </button>
          </section>
        </template>
      </template>
    </div>
  </main>
</template>
