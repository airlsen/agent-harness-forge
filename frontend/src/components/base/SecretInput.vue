<script setup lang="ts">
// 已保存的密钥：默认显示圆点；点击右侧眼睛图标时向服务端取回真实值并填入输入框，可直接改写。
// 列表 / 详情接口不回传密钥，只有点击查看时才单独请求一次。
import { ref } from 'vue';
import { usePlatform } from '../../stores/platform';

const props = defineProps<{
  value: string;
  /** 服务端已保存密钥 */
  saved: boolean;
  /** 取回已保存密钥的明文 */
  reveal: () => Promise<string>;
  placeholder?: string;
  autocomplete?: string;
}>();
const emit = defineEmits<{ 'update:value': [value: string]; revealed: [value: string] }>();

const app = usePlatform();
const visible = ref(false);
const loading = ref(false);

async function changeVisible(next: boolean) {
  visible.value = next;
  // 输入框为空且已有保存的密钥时才去取；已取回或正在改写时只切换显示。
  if (!next || !props.saved || props.value || loading.value) return;
  loading.value = true;
  try {
    const key = await props.reveal();
    emit('revealed', key);
    emit('update:value', key);
  } catch (error) {
    visible.value = false;
    app.toast((error as Error).message, 'error');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <a-input-password
    :value="value"
    :visible="visible"
    :disabled="loading"
    :autocomplete="autocomplete ?? 'off'"
    :placeholder="saved ? '••••••••••••' : placeholder"
    @update:value="emit('update:value', $event ?? '')"
    @update:visible="changeVisible"
  />
</template>
