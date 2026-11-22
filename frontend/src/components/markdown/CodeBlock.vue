<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { highlightCode, normalizeLang } from '../../utils/highlight';
import { useCopy } from '../../utils/useCopy';
import Icon from '../base/ForgeIcon.vue';

const props = withDefaults(defineProps<{ code: string; lang?: string; live?: boolean }>(), {
  lang: '',
  live: false,
});

const { copied, copy } = useCopy();
const html = ref('');
const displayLang = computed(() => normalizeLang(props.lang) || props.lang.trim().toLowerCase() || 'text');
let seq = 0;
let timer: number | undefined;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
function renderPlain() {
  const text = props.code.replace(/[&<>"]/g, (ch) => ESCAPES[ch]);
  html.value = `<pre class="plain-code"><code>${text}</code></pre>`;
}

async function highlight() {
  const my = ++seq;
  const lang = normalizeLang(props.lang);
  if (!lang) {
    renderPlain();
    return;
  }
  try {
    const result = await highlightCode(props.code, lang);
    if (my === seq) html.value = result;
  } catch {
    if (my === seq) renderPlain();
  }
}

watch(
  () => [props.code, props.lang],
  () => {
    window.clearTimeout(timer);
    if (props.live) timer = window.setTimeout(() => void highlight(), 140);
    else void highlight();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  ++seq;
  window.clearTimeout(timer);
});
</script>

<template>
  <figure class="code-block is-code">
    <figcaption class="code-head">
      <span class="code-lang">{{ displayLang }}</span>
      <button class="code-copy" type="button" @click="copy(code)">
        <Icon :name="copied ? 'check' : 'copy'" :size="12" />{{ copied ? '已复制' : '复制' }}
      </button>
    </figcaption>
    <div class="code-body" v-html="html"></div>
  </figure>
</template>
