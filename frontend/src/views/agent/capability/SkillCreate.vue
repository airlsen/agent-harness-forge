<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { Rule } from 'ant-design-vue/es/form';
import { post } from '../../../api/client';
import Icon from '../../../components/ForgeIcon.vue';
import type { SkillDetail } from '../../../types/skill';

const router = useRouter();
const form = reactive({ name: '', description: '', startMode: 'assistant' as 'assistant' | 'blank' });
const creating = ref(false);
const error = ref('');

// antd 表单校验规则：名称必填且不超过 120 字符，用途说明选填且不超过 512 字符。
const rules: Record<string, Rule[]> = {
  name: [
    { required: true, whitespace: true, message: '请填写 Skill 名称' },
    { max: 120, message: 'Skill 名称不能超过 120 个字符' },
  ],
  description: [{ max: 512, message: '用途说明不能超过 512 个字符' }],
};
const startModes = [
  {
    value: 'assistant',
    icon: 'sparkles',
    title: '由助手协助生成',
    description: '创建后直接进入工作台，描述预期方法并生成第一版草稿。',
  },
  {
    value: 'blank',
    icon: 'edit',
    title: '从空白草稿开始',
    description: '使用标准结构创建初稿，并从内容编辑器开始编写。',
  },
] as const;

async function createSkill() {
  if (creating.value) return;
  creating.value = true;
  error.value = '';
  try {
    const skill = await post<SkillDetail>('/skills', {
      name: form.name.trim(),
      description: form.description.trim(),
    });
    await router.replace({
      path: `/agent/skills/${skill.id}`,
      query: form.startMode === 'assistant' ? { start: 'generate' } : {},
    });
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <main class="page-content enterprise-page skill-create-page">
    <div class="enterprise-page-inner skill-create-inner">
      <a-breadcrumb class="skill-breadcrumb">
        <a-breadcrumb-item
          ><RouterLink to="/agent/capabilities?tab=skills">技能管理</RouterLink></a-breadcrumb-item
        >
        <a-breadcrumb-item><RouterLink to="/agent/skills">技能</RouterLink></a-breadcrumb-item>
        <a-breadcrumb-item>新建技能</a-breadcrumb-item>
      </a-breadcrumb>
      <header class="skill-create-heading">
        <h1>新建技能</h1>
        <p>创建后先保存为草稿，可手动编写或让助手协助完善。</p>
      </header>

      <a-form class="skill-create-form" :model="form" :rules="rules" layout="vertical" @finish="createSkill">
        <section class="skill-create-section">
          <header class="skill-section-heading">
            <span class="skill-step">1</span>
            <div>
              <h2>定义用途</h2>
              <p>清晰的名称和用途能帮助团队理解何时应该使用这个 Skill。</p>
            </div>
          </header>
          <a-form-item label="Skill 名称" name="name">
            <a-input v-model:value="form.name" :maxlength="120" placeholder="例如：客户工单总结" />
          </a-form-item>
          <a-form-item label="用途说明" name="description">
            <a-textarea
              v-model:value="form.description"
              :maxlength="512"
              :rows="4"
              show-count
              placeholder="例如：将客户工单整理为结构化摘要，标出待跟进事项并形成可直接发送给客户的回复建议。"
            />
          </a-form-item>
        </section>
        <section class="skill-create-section">
          <header class="skill-section-heading">
            <span class="skill-step">2</span>
            <div>
              <h2>选择开始方式</h2>
              <p>两种方式都会创建未发布草稿；助手只能修改草稿，不能自动发布。</p>
            </div>
          </header>
          <a-radio-group v-model:value="form.startMode" class="skill-start-options">
            <a-radio
              v-for="mode in startModes"
              :key="mode.value"
              :value="mode.value"
              :class="['skill-start-option', { 'is-selected': form.startMode === mode.value }]"
            >
              <span class="skill-start-option-body">
                <span class="scene-icon book skill-start-option-icon"
                  ><Icon :name="mode.icon" :size="18"
                /></span>
                <span class="skill-start-option-copy">
                  <strong>{{ mode.title }}</strong>
                  <small>{{ mode.description }}</small>
                </span>
              </span>
            </a-radio>
          </a-radio-group>
        </section>
        <a-alert v-if="error" class="skill-create-error" type="error" show-icon :message="error" />
        <footer class="skill-create-actions">
          <RouterLink v-slot="{ href, navigate }" to="/agent/skills" custom>
            <a-button :href="href" @click="navigate">取消</a-button>
          </RouterLink>
          <a-button type="primary" html-type="submit" :loading="creating">
            {{ form.startMode === 'assistant' ? '创建并开始生成' : '创建草稿' }}
          </a-button>
        </footer>
      </a-form>
    </div>
  </main>
</template>

<style scoped>
.skill-create-inner {
  max-width: 900px;
}
.skill-breadcrumb {
  margin-bottom: 16px;
}
.skill-create-heading {
  margin-bottom: 24px;
}
.skill-create-heading h1 {
  margin: 0;
  color: var(--color-text-primary);
  font-size: var(--page-title-size);
  font-weight: 600;
  letter-spacing: -0.6px;
}
.skill-create-heading p {
  margin: 8px 0 0;
  color: var(--color-text-secondary);
  font-size: 13px;
  line-height: 1.75;
}
/* 表单整体是一张扁平卡片，分区之间用细线分隔 */
.skill-create-form {
  overflow: hidden;
  background: var(--surface-card);
  border: 1px solid var(--border-default);
  border-radius: 8px;
}
.skill-create-section {
  padding: 24px;
}
.skill-create-section + .skill-create-section {
  border-top: 1px solid var(--border-default);
}
.skill-section-heading {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 20px;
}
.skill-step {
  display: grid;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 50%;
  color: var(--color-brand-active);
  background: var(--color-brand-muted);
  font-size: 12px;
  font-weight: 600;
}
.skill-section-heading h2 {
  margin: 0;
  color: var(--color-text-primary);
  font-size: 15px;
  font-weight: 600;
  line-height: 24px;
}
.skill-section-heading p {
  margin: 4px 0 0;
  color: var(--color-text-secondary);
  font-size: 13px;
  line-height: 1.7;
}
.skill-create-section :deep(.ant-form-item:last-child) {
  margin-bottom: 0;
}
.skill-create-section :deep(.ant-input) {
  min-height: 0; /* 中和 style.css 全局 :where(input){min-height:41px} */
}

/* 开始方式：antd Radio 做成两张可选卡片；选中只换主题色边框，不改尺寸 */
.skill-start-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  width: 100%;
}
.skill-start-option {
  display: flex;
  align-items: flex-start;
  margin: 0;
  padding: 16px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  transition: border-color 150ms ease;
}
.skill-start-option:hover,
.skill-start-option.is-selected {
  border-color: var(--color-brand);
}
.skill-start-option :deep(.ant-radio) {
  align-self: flex-start;
  margin-top: 2px;
}
.skill-start-option-body {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.skill-start-option-icon {
  width: 36px;
  height: 36px;
  border-radius: 8px;
}
.skill-start-option-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.skill-start-option-copy strong {
  color: var(--color-text-primary);
  font-size: 14px;
  font-weight: 600;
}
.skill-start-option-copy small {
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.skill-create-error {
  margin: 0 24px 16px;
}
.skill-create-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 24px;
  border-top: 1px solid var(--border-default);
}
@media (max-width: 660px) {
  .skill-create-section {
    padding: 18px;
  }
  .skill-start-options {
    grid-template-columns: minmax(0, 1fr);
  }
  .skill-create-error {
    margin-inline: 18px;
  }
  .skill-create-actions {
    padding-inline: 18px;
  }
}
</style>
