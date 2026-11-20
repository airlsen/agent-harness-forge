<script setup lang="ts">
/**
 * JsonPreview — 公共 JSON 美化预览组件（黄色主题）
 * 与 MarkdownPreview 同级，位于 components/common
 * 能力：折叠/展开、类型徽标、统计、搜索高亮、复制、全展/收起
 * 主题：黄色系 #eab308，与 MarkdownPreview 保持一致
 */
import { ref, computed, watch, defineComponent, h } from 'vue'
import { useCopy } from '../../utils/useCopy'

interface Props {
  data: unknown
  rootName?: string
  expanded?: boolean
  showType?: boolean
  maxHeight?: string
  searchable?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  rootName: 'root',
  expanded: false,
  showType: false,
  maxHeight: '',
  searchable: true,
})

const expandedNodes = ref<Set<string>>(new Set())
const search = ref('')
const copiedPath = ref<string>('')

const { copied, copy } = useCopy()

const jsonString = computed(() => {
  try {
    return JSON.stringify(props.data, null, 2)
  } catch {
    return String(props.data)
  }
})
const totalKeys = computed(() => {
  if (props.data && typeof props.data === 'object') return Object.keys(props.data as Record<string, unknown>).length
  return 0
})
const sizeLabel = computed(() => {
  const bytes = new Blob([jsonString.value]).size
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
})

if (props.expanded) expandedNodes.value.add('root')

watch(
  () => props.expanded,
  (v: boolean) => {
    if (v) expandedNodes.value.add('root')
    else expandedNodes.value.delete('root')
  },
)

const handleToggle = (path: string) => {
  if (expandedNodes.value.has(path)) expandedNodes.value.delete(path)
  else expandedNodes.value.add(path)
}

const expandAll = () => {
  const collect = (val: unknown, path: string) => {
    if (val !== null && typeof val === 'object') {
      expandedNodes.value.add(path)
      if (Array.isArray(val)) val.forEach((item, i) => collect(item, `${path}.${i}`))
      else Object.entries(val as Record<string, unknown>).forEach(([k, v]) => collect(v, `${path}.${k}`))
    }
  }
  collect(props.data, props.rootName)
}
const collapseAll = () => expandedNodes.value.clear()

const copyJson = async () => {
  await copy(jsonString.value)
}
const copyNode = async (path: string, value: unknown) => {
  try {
    await copy(JSON.stringify(value, null, 2))
    copiedPath.value = path
    setTimeout(() => (copiedPath.value = ''), 1400)
  } catch {
    // ignore
  }
}

const themeStyle = {
  '--jp-primary': '#eab308',
  '--jp-primary-hover': '#ca8a04',
  '--jp-primary-soft': '#fef9c3',
  '--jp-primary-muted': '#fefce8',
  '--jp-primary-border': '#fde68a',
  '--jp-primary-ring': 'rgba(234,179,8,0.32)',
} as Record<string, string>

// 递归子组件（局部定义，避免单文件双 script setup 冲突）
const JsonNode = defineComponent({
  name: 'JsonNode',
  props: {
    data: { required: true },
    name: { type: String, required: true },
    level: { type: Number, required: true },
    path: { type: String, default: '' },
    showType: { type: Boolean, default: false },
    expandedSet: { type: Object as unknown as () => Set<string>, required: true },
    search: { type: String, default: '' },
  },
  emits: ['toggle', 'copy'],
  setup(p, { emit }) {
    const nodePath = computed(() => (p.path ? `${p.path}.${p.name}` : p.name))
    const isExpanded = computed(() => (p.expandedSet as Set<string>).has(nodePath.value))
    const dataType = computed(() => {
      if (p.data === null) return 'null'
      if (Array.isArray(p.data)) return 'array'
      return typeof p.data
    })
    const isExpandable = computed(() => dataType.value === 'object' || dataType.value === 'array')
    const childCount = computed(() => {
      const d = p.data as Record<string, unknown> & unknown[]
      if (dataType.value === 'array') return (d as unknown[]).length
      if (dataType.value === 'object') return Object.keys(d as Record<string, unknown>).length
      return 0
    })
    const typeColor = (t: string) => {
      const m: Record<string, string> = {
        string: '#16a34a',
        number: '#2563eb',
        boolean: '#7c3aed',
        null: '#6b7280',
        undefined: '#6b7280',
        object: '#a16207',
        array: '#ca8a04',
      }
      return m[t] || '#6b7280'
    }
    const displayValue = (v: unknown) => {
      if (v === null) return 'null'
      if (v === undefined) return 'undefined'
      if (typeof v === 'string') return `"${v}"`
      return String(v)
    }
    const highlightName = computed(() => {
      if (!p.search) return p.name
      const idx = p.name.toLowerCase().indexOf(p.search.toLowerCase())
      if (idx === -1) return p.name
      const before = p.name.slice(0, idx)
      const hit = p.name.slice(idx, idx + p.search.length)
      const after = p.name.slice(idx + p.search.length)
      return `${before}<mark class="jp-hit">${hit}</mark>${after}`
    })
    const toggle = () => {
      if (isExpandable.value) emit('toggle', nodePath.value)
    }
    return { nodePath, isExpanded, dataType, isExpandable, childCount, typeColor, displayValue, highlightName, toggle }
  },
  template: `
    <div :class="['jp-node', 'jp-' + dataType]" :style="{ paddingLeft: level * 14 + 'px' }">
      <div class="jp-header" @click="toggle">
        <span v-if="isExpandable" :class="['jp-arrow', { 'is-open': isExpanded }]">▶</span>
        <span v-else class="jp-arrow ph"></span>
        <span class="jp-name" v-html="highlightName"></span>
        <span v-if="showType" class="jp-type" :style="{ color: typeColor(dataType), borderColor: typeColor(dataType) + '33', background: typeColor(dataType) + '12' }">{{ dataType }}</span>
        <span class="jp-sep">:</span>
        <span v-if="!isExpandable" class="jp-value" :style="{ color: typeColor(dataType) }">{{ displayValue(data) }}</span>
        <span v-else-if="!isExpanded" class="jp-preview">{{ dataType === 'array' ? '[' + childCount + ']' : '{' + childCount + '}' }}</span>
        <span class="jp-actions" @click.stop>
          <button class="jp-mini-btn" type="button" @click="$emit('copy', nodePath, data)" title="复制此节点">⧉</button>
        </span>
      </div>
      <div v-if="isExpandable && isExpanded" class="jp-children">
        <template v-if="dataType === 'array'">
          <JsonNode
            v-for="(item, index) in (data as any[])"
            :key="index"
            :data="item"
            :name="String(index)"
            :level="level + 1"
            :path="nodePath"
            :show-type="showType"
            :expanded-set="expandedSet"
            :search="search"
            @toggle="$emit('toggle', $event)"
            @copy="$emit('copy', $event)"
          />
        </template>
        <template v-else>
          <JsonNode
            v-for="(_, key) in (data as Record<string, unknown>)"
            :key="key"
            :data="(data as Record<string, unknown>)[key as string]"
            :name="String(key)"
            :level="level + 1"
            :path="nodePath"
            :show-type="showType"
            :expanded-set="expandedSet"
            :search="search"
            @toggle="$emit('toggle', $event)"
            @copy="$emit('copy', $event)"
          />
        </template>
      </div>
    </div>
  `,
})
</script>

<template>
  <div class="json-preview" :style="[themeStyle as any, maxHeight ? { maxHeight, overflowY: 'auto' } : {}]">
    <div class="jp-toolbar">
      <div class="jp-title">
        <span class="jp-badge">{ }</span>
        <strong>{{ rootName }}</strong>
        <span class="jp-meta">{{ Array.isArray(data) ? `Array[${totalKeys}]` : `Object{${totalKeys}}` }} · {{ sizeLabel }}</span>
      </div>
      <div class="jp-tools">
        <div v-if="searchable" class="jp-search">
          <input v-model="search" placeholder="搜索 key…" />
          <span v-if="search" class="jp-clear" @click="search = ''">×</span>
        </div>
        <button class="jp-btn" type="button" @click="expandAll">全部展开</button>
        <button class="jp-btn" type="button" @click="collapseAll">全部收起</button>
        <button class="jp-btn primary" type="button" @click="copyJson">
          {{ copied ? '已复制' : '复制 JSON' }}
        </button>
      </div>
    </div>

    <div class="jp-content">
      <JsonNode
        :data="data"
        :name="rootName"
        :level="0"
        :path="''"
        :show-type="showType"
        :expanded-set="expandedNodes"
        :search="search"
        @toggle="handleToggle"
        @copy="copyNode"
      />
      <div v-if="copiedPath" class="jp-toast">已复制 {{ copiedPath }}</div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.json-preview {
  --jp-primary: #eab308;
  --jp-primary-hover: #ca8a04;
  --jp-primary-soft: #fef9c3;
  --jp-primary-muted: #fefce8;
  --jp-primary-border: #fde68a;
  --jp-primary-ring: rgba(234, 179, 8, 0.32);
  font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.6;
  background: var(--surface-card);
  border: 1px solid var(--jp-primary-border);
  border-radius: 14px;
  overflow: hidden;
  box-shadow:
    0 4px 16px rgba(234, 179, 8, 0.1),
    var(--shadow-xs);

  .jp-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    background: linear-gradient(135deg, var(--jp-primary-muted), var(--jp-primary-soft));
    border-bottom: 1px solid var(--jp-primary-border);
    flex-wrap: wrap;

    .jp-title {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      .jp-badge {
        width: 26px;
        height: 26px;
        display: grid;
        place-items: center;
        background: var(--jp-primary);
        color: #422006;
        border-radius: 8px;
        font-weight: 800;
        font-size: 12px;
        box-shadow: 0 1px 6px rgba(234, 179, 8, 0.35);
      }
      strong {
        color: #713f12;
        font-size: 13px;
      }
      .jp-meta {
        color: var(--color-text-tertiary);
        font-size: 11px;
        background: #fff;
        border: 1px solid var(--jp-primary-border);
        padding: 2px 8px;
        border-radius: 999px;
      }
    }

    .jp-tools {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;

      .jp-search {
        position: relative;
        input {
          width: 160px;
          height: 32px;
          padding: 6px 28px 6px 10px;
          border: 1px solid var(--jp-primary-border);
          border-radius: 10px;
          background: #fff;
          font-size: 12px;
          color: var(--color-text-primary);
          outline: none;
          &:focus {
            border-color: var(--jp-primary);
            box-shadow: 0 0 0 3px var(--jp-primary-ring);
          }
        }
        .jp-clear {
          position: absolute;
          right: 8px;
          top: 50%;
          transform: translateY(-50%);
          width: 18px;
          height: 18px;
          display: grid;
          place-items: center;
          border-radius: 50%;
          background: var(--jp-primary-muted);
          color: var(--jp-primary-hover);
          cursor: pointer;
          font-size: 12px;
        }
      }

      .jp-btn {
        height: 32px;
        padding: 0 12px;
        border-radius: 10px;
        border: 1px solid var(--jp-primary-border);
        background: #fff;
        color: #713f12;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s;
        &:hover {
          background: var(--jp-primary);
          border-color: var(--jp-primary);
          color: #422006;
          transform: translateY(-1px);
        }
        &.primary {
          background: var(--jp-primary);
          border-color: var(--jp-primary);
          color: #422006;
          box-shadow: 0 2px 8px rgba(234, 179, 8, 0.28);
          &:hover {
            background: var(--jp-primary-hover);
          }
        }
      }
    }
  }

  .jp-content {
    padding: 14px 10px 16px;
    background: var(--surface-card);
    position: relative;
  }

  :deep(.jp-node) {
    .jp-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 6px;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.12s;
      &:hover {
        background: var(--jp-primary-muted);
      }
      .jp-arrow {
        width: 14px;
        height: 14px;
        display: grid;
        place-items: center;
        font-size: 9px;
        color: var(--jp-primary-hover);
        transition: transform 0.18s;
        flex-shrink: 0;
        &.is-open {
          transform: rotate(90deg);
        }
        &.ph {
          width: 14px;
        }
      }
      .jp-name {
        color: #713f12;
        font-weight: 600;
        font-size: 12.5px;
      }
      .jp-type {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        padding: 1px 6px;
        border-radius: 999px;
        border: 1px solid;
      }
      .jp-sep {
        color: var(--color-text-tertiary);
        margin: 0 1px;
      }
      .jp-value {
        font-weight: 600;
      }
      .jp-preview {
        color: var(--color-text-tertiary);
        font-style: italic;
        font-size: 11px;
        background: var(--surface-muted);
        padding: 1px 6px;
        border-radius: 6px;
      }
      .jp-actions {
        margin-left: auto;
        opacity: 0;
        transition: opacity 0.15s;
        .jp-mini-btn {
          width: 22px;
          height: 22px;
          display: grid;
          place-items: center;
          border-radius: 6px;
          border: 1px solid var(--jp-primary-border);
          background: #fff;
          color: var(--jp-primary-hover);
          cursor: pointer;
          font-size: 11px;
        }
      }
      &:hover .jp-actions {
        opacity: 1;
      }
      .jp-hit {
        background: var(--jp-primary);
        color: #422006;
        padding: 0 2px;
        border-radius: 3px;
      }
    }
    .jp-children {
      border-left: 1px dashed var(--jp-primary-border);
      margin-left: 6px;
      margin-top: 2px;
    }
    &.jp-object > .jp-header .jp-name {
      color: var(--jp-primary-hover);
    }
    &.jp-array > .jp-header .jp-name {
      color: #ca8a04;
    }
    &.jp-string .jp-value {
      color: #16a34a;
    }
    &.jp-number .jp-value {
      color: #2563eb;
    }
    &.jp-boolean .jp-value {
      color: #7c3aed;
    }
    &.jp-null .jp-value {
      color: #6b7280;
      font-style: italic;
    }
  }

  .jp-toast {
    position: absolute;
    right: 12px;
    bottom: 12px;
    background: var(--jp-primary);
    color: #422006;
    font-size: 11px;
    font-weight: 700;
    padding: 6px 10px;
    border-radius: 999px;
    box-shadow: var(--shadow-md);
  }
}

@media (max-width: 768px) {
  .json-preview {
    font-size: 12px;
    .jp-toolbar .jp-tools .jp-search input {
      width: 120px;
    }
  }
}
</style>
