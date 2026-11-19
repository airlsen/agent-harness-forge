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
      <nav class="skill-breadcrumb" aria-label="面包屑">
        <RouterLink to="/agent/capabilities?tab=skills">技能管理</RouterLink
        ><Icon name="chevron" :size="14" /><RouterLink to="/agent/skills">技能</RouterLink
        ><Icon name="chevron" :size="14" /><span aria-current="page">新建技能</span>
      </nav>
      <header class="skill-create-page-heading">
        <span class="skill-create-page-icon"><Icon name="sparkles" :size="25" /></span>
        <div>
          <h1>新建技能</h1>
          <p>创建后先保存为草稿，可手动编写或让助手协助完善。</p>
        </div>
      </header>

      <a-form
        class="skill-create-workflow"
        :model="form"
        :rules="rules"
        layout="vertical"
        @finish="createSkill"
      >
        <section class="skill-create-section">
          <div class="skill-section-heading">
            <span>01</span>
            <div>
              <h2>定义用途</h2>
              <p>清晰的名称和用途能帮助团队理解何时应该使用这个 Skill。</p>
            </div>
          </div>
          <a-form-item label="Skill 名称" name="name">
            <a-input v-model:value="form.name" :maxlength="120" placeholder="例如：客户工单总结" />
          </a-form-item>
          <a-form-item label="用途说明" name="description">
            <a-textarea
              v-model:value="form.description"
              :maxlength="512"
              :rows="4"
              placeholder="例如：将客户工单整理为结构化摘要，标出待跟进事项并形成可直接发送给客户的回复建议。"
            />
          </a-form-item>
        </section>
        <section class="skill-create-section skill-start-section">
          <div class="skill-section-heading">
            <span>02</span>
            <div>
              <h2>选择开始方式</h2>
              <p>两种方式都会创建未发布草稿；助手只能修改草稿，不能自动发布。</p>
            </div>
          </div>
          <div class="skill-start-options">
            <label :class="['skill-start-option', { selected: form.startMode === 'assistant' }]">
              <input v-model="form.startMode" type="radio" value="assistant" />
              <span class="skill-start-option-icon"><Icon name="sparkles" :size="20" /></span>
              <span
                ><strong>由助手协助生成</strong
                ><small>创建后直接进入工作台，描述预期方法并生成第一版草稿。</small></span
              >
              <Icon
                v-if="form.startMode === 'assistant'"
                name="check"
                :size="18"
                class="skill-option-check"
              />
            </label>
            <label :class="['skill-start-option', { selected: form.startMode === 'blank' }]">
              <input v-model="form.startMode" type="radio" value="blank" />
              <span class="skill-start-option-icon neutral"><Icon name="edit" :size="20" /></span>
              <span
                ><strong>从空白草稿开始</strong
                ><small>使用标准结构创建初稿，并从内容编辑器开始编写。</small></span
              >
              <Icon v-if="form.startMode === 'blank'" name="check" :size="18" class="skill-option-check" />
            </label>
          </div>
        </section>
        <p v-if="error" class="form-alert error skill-create-error" role="alert">
          <Icon name="info" :size="17" /><span>{{ error }}</span>
        </p>
        <footer class="skill-create-actions">
          <RouterLink to="/agent/skills" class="button secondary">取消</RouterLink
          ><button type="submit" class="button primary" :disabled="creating">
            <Icon name="sparkles" :size="16" />{{
              creating ? '正在创建…' : form.startMode === 'assistant' ? '创建并开始生成' : '创建草稿'
            }}
          </button>
        </footer>
      </a-form>
    </div>
  </main>
</template>
