<script setup lang="ts">
import { computed } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
const props = defineProps<{ text: string }>();
const rendered = computed(() =>
  DOMPurify.sanitize(marked.parse(props.text, { breaks: true, async: false }) as string, {
    FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button', 'img'],
    FORBID_ATTR: ['style'],
  }),
);
</script>
<template><div class="markdown-body" v-html="rendered"></div></template>
