<script setup lang="ts">
import { onUnmounted } from 'vue';
import { App } from 'ant-design-vue';
import { bindFeedbackApi } from '../../utils/common/feedback';

// 把主题感知的 message / modal 实例挂到模块单例，
// 供 store 的 toast 与页面确认弹窗使用。本组件必须渲染在 <a-app> 之内才能拿到上下文。
const { message, modal } = App.useApp();
bindFeedbackApi({ message, modal });
onUnmounted(() => bindFeedbackApi(null));
</script>
