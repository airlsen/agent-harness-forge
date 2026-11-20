<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, lineNumbers, keymap, highlightActiveLine, drawSelection } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { searchKeymap } from '@codemirror/search';
const props = defineProps<{ modelValue: string; readonly?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const host = ref<HTMLElement>();
const editable = new Compartment();
let view: EditorView | undefined;
onMounted(() => {
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        markdown(),
        syntaxHighlighting(
          HighlightStyle.define([
            { tag: tags.heading, color: 'var(--color-brand-active)', fontWeight: '600' },
            { tag: tags.strong, fontWeight: '700' },
            { tag: tags.emphasis, fontStyle: 'italic' },
            { tag: [tags.link, tags.url], color: 'var(--color-info-text)' },
            { tag: tags.monospace, color: 'var(--color-success-text)' },
            { tag: tags.meta, color: 'var(--color-text-tertiary)' },
          ]),
        ),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        EditorView.lineWrapping,
        editable.of(EditorState.readOnly.of(!!props.readonly)),
        EditorView.contentAttributes.of({ 'aria-label': 'Skill Markdown 源码' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) emit('update:modelValue', update.state.doc.toString());
        }),
        EditorView.theme({
          '&': {
            height: '100%',
            color: 'var(--color-text-primary)',
            backgroundColor: 'var(--surface-content)',
            fontSize: '13px',
          },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono, monospace)', lineHeight: '1.8' },
          '.cm-content': { padding: '16px 0' },
          '.cm-gutters': {
            backgroundColor: 'var(--surface-content)',
            color: 'var(--color-text-tertiary)',
            border: 'none',
          },
          '.cm-activeLine': { backgroundColor: 'var(--surface-shell)' },
          '.cm-cursor': { borderLeftColor: 'var(--color-brand)' },
          '&.cm-focused': { outline: 'none' },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
            backgroundColor: 'var(--color-brand-subtle)',
          },
        }),
      ],
    }),
  });
});
watch(
  () => props.modelValue,
  (value) => {
    if (view && value !== view.state.doc.toString())
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  },
);
watch(
  () => props.readonly,
  (value) => view?.dispatch({ effects: editable.reconfigure(EditorState.readOnly.of(!!value)) }),
);
onBeforeUnmount(() => view?.destroy());
</script>
<template><div ref="host" class="skill-source-editor" /></template>
<style scoped>
.skill-source-editor {
  height: 100%;
  min-height: 0;
}
</style>
