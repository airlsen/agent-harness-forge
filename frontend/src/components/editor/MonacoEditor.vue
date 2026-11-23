<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type * as Monaco from 'monaco-editor/editor';
import { loadMonaco } from '../../utils/editor/monaco';
import { minimalTextEdit } from '../../utils/editor/textEdit';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    modelKey?: string;
    language?: string;
    theme?: 'vs' | 'vs-dark' | 'hc-black';
    readOnly?: boolean;
    active?: boolean;
    loading?: boolean;
    height?: string;
    ariaLabel?: string;
    options?: Monaco.editor.IStandaloneEditorConstructionOptions;
  }>(),
  {
    modelKey: 'document',
    language: 'markdown',
    theme: 'vs-dark',
    readOnly: false,
    active: true,
    loading: false,
    height: '100%',
    ariaLabel: '源码编辑器',
    options: () => ({}),
  },
);
const emit = defineEmits<{
  'update:modelValue': [value: string];
  change: [value: string];
  ready: [editor: Monaco.editor.IStandaloneCodeEditor];
  'shortcut-save': [];
  'content-selected': [payload: { text: string; range: { startLine: number; endLine: number } }];
  'selection-cleared': [];
}>();
const host = ref<HTMLElement>();
const error = ref('');
const initializing = ref(true);
let monaco: typeof Monaco | undefined;
let editor: Monaco.editor.IStandaloneCodeEditor | undefined;
let disposed = false;
let syncing = false;
let currentKey: string | undefined;
const models = new Map<string, Monaco.editor.ITextModel>();
const views = new Map<string, Monaco.editor.ICodeEditorViewState>();
const listeners: Monaco.IDisposable[] = [];

function saveView() {
  const view = editor?.saveViewState();
  if (view && currentKey !== undefined) views.set(currentKey, view);
}

function syncDocument() {
  if (!editor || !monaco || props.loading) return;
  syncing = true;
  try {
    if (currentKey !== props.modelKey) {
      if (props.active) saveView();
      let model = models.get(props.modelKey);
      if (!model) {
        model = monaco.editor.createModel(props.modelValue, props.language);
        models.set(props.modelKey, model);
      }
      currentKey = props.modelKey;
      editor.setModel(model);
      const view = views.get(currentKey);
      if (view) editor.restoreViewState(view);
      emit('selection-cleared');
    }
    const model = editor.getModel();
    if (!model) return;
    if (model.getLanguageId() !== props.language) monaco.editor.setModelLanguage(model, props.language);
    const edit = minimalTextEdit(model.getValue(), props.modelValue);
    if (!edit) return;
    const view = editor.saveViewState();
    const start = model.getPositionAt(edit.start);
    const end = model.getPositionAt(edit.end);
    // AI / 服务端回写成为一个独立的撤销步骤，且不会再次触发父组件自动保存。
    model.pushStackElement();
    model.pushEditOperations(
      editor.getSelections(),
      [
        {
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          text: edit.text,
        },
      ],
      () => null,
    );
    model.pushStackElement();
    if (view) editor.restoreViewState(view);
  } finally {
    syncing = false;
  }
}

function updateOptions() {
  editor?.updateOptions({
    ...props.options,
    readOnly: props.readOnly || props.loading,
    ariaLabel: props.ariaLabel,
  });
}

async function initialize() {
  initializing.value = true;
  error.value = '';
  try {
    const loaded = await loadMonaco();
    if (disposed || !host.value) return;
    monaco = loaded;
    editor = loaded.editor.create(host.value, {
      model: null,
      theme: props.theme,
      automaticLayout: true,
      fontSize: 14,
      lineHeight: 22,
      fontFamily: 'Consolas, "SFMono-Regular", Menlo, monospace',
      lineNumbers: 'on',
      minimap: { enabled: false },
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      folding: true,
      tabSize: 2,
      padding: { top: 20, bottom: 20 },
      overviewRulerBorder: false,
      renderLineHighlight: 'line',
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
      ...props.options,
      readOnly: props.readOnly || props.loading,
      ariaLabel: props.ariaLabel,
    });
    listeners.push(
      editor.onDidChangeModelContent(() => {
        if (syncing || currentKey !== props.modelKey || props.loading) return;
        const value = editor!.getValue();
        emit('update:modelValue', value);
        emit('change', value);
      }),
      editor.onDidChangeCursorSelection(() => {
        if (syncing) return;
        const selection = editor?.getSelection();
        const text = selection && editor?.getModel()?.getValueInRange(selection);
        if (!selection || !text?.trim()) emit('selection-cleared');
        else
          emit('content-selected', {
            text,
            range: { startLine: selection.startLineNumber, endLine: selection.endLineNumber },
          });
      }),
    );
    editor.addCommand(loaded.KeyMod.CtrlCmd | loaded.KeyCode.KeyS, () => emit('shortcut-save'));
    syncDocument();
    emit('ready', editor);
  } catch {
    if (!disposed) error.value = '源码编辑器加载失败，请重试。';
  } finally {
    if (!disposed) initializing.value = false;
  }
}

watch(() => [props.modelKey, props.modelValue, props.language, props.loading], syncDocument, {
  flush: 'post',
});
watch(() => [props.readOnly, props.loading, props.options, props.ariaLabel], updateOptions, { deep: true });
watch(
  () => props.theme,
  (theme) => monaco?.editor.setTheme(theme),
);
watch(
  () => props.active,
  async (active) => {
    if (!active) saveView();
    else {
      await nextTick();
      editor?.layout();
      const view = currentKey === undefined ? undefined : views.get(currentKey);
      if (view) editor?.restoreViewState(view);
    }
  },
);
onMounted(initialize);
onBeforeUnmount(() => {
  disposed = true;
  listeners.forEach((listener) => listener.dispose());
  editor?.dispose();
  models.forEach((model) => model.dispose());
  models.clear();
  views.clear();
});
defineExpose({
  getEditor: () => editor,
  getValue: () => editor?.getValue() ?? props.modelValue,
  focus: () => editor?.focus(),
  layout: () => editor?.layout(),
});
</script>

<template>
  <div class="forge-monaco" :style="{ height }" :data-editor-theme="theme">
    <div ref="host" class="forge-monaco-host" />
    <div v-if="initializing || error" class="forge-monaco-status" role="status">
      <span>{{ error || '正在加载编辑器…' }}</span>
      <button v-if="error" type="button" @click="initialize">重试</button>
    </div>
  </div>
</template>

<style scoped>
.forge-monaco {
  position: relative;
  width: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--source-editor-bg);
  color: var(--source-editor-text);
}
.forge-monaco[data-editor-theme='vs'] {
  background: var(--surface-content);
  color: var(--color-text-primary);
}
.forge-monaco-host {
  height: 100%;
  width: 100%;
}
.forge-monaco-status {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: inherit;
  font-size: 13px;
}
.forge-monaco-status button {
  color: inherit;
  text-decoration: underline;
}
</style>
