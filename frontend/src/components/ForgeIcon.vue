<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 });
const paths: Record<string, string> = {
  home: 'M3 10l9-7 9 7v11h-6v-7H9v7H3V10z',
  building: 'M4 21V3h12v18 M16 9h4v12 M8 7h4 M8 11h4 M8 15h4 M8 21v-3h4v3 M2 21h20',
  users:
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  pause: 'M8 5v14 M16 5v14',
  arrowDown: 'M12 5v14 M6 13l6 6 6-6',
  external: 'M15 3h6v6 M10 14L21 3 M21 14v7H3V3h7',
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  message: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 1 1 19 0z M7 9h9 M7 13h6',
  sparkles: 'M12 3l2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3z M20 2v4 M18 4h4',
  plus: 'M12 5v14 M5 12h14',
  play: 'M8 5l12 7-12 7V5z',
  terminal: 'M4 5h16v14H4z M7 9l3 3-3 3 M13 15h4',
  shield: 'M12 3l8 3v6c0 5-8 9-8 9S4 17 4 12V6l8-3z M8.5 12l2.5 2.5 4.5-5',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  box: 'M12 3l9 5-9 5-9-5 9-5z M3 8v9l9 5 9-5V8 M12 13v9 M7 5.8l10 5.5',
  blocks: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M17.5 13v9 M13 17.5h9',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  arrowLeft: 'M19 12H5 M11 6l-6 6 6 6',
  arrowUp: 'M12 19V5 M6 11l6-6 6 6',
  chevron: 'M9 5l7 7-7 7',
  chevronDown: 'M6 9l6 6 6-6',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',
  clock: 'M12 8v4l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  check: 'M5 12l4 4L19 6',
  close: 'M6 6l12 12 M6 18L18 6',
  info: 'M12 11v6 M12 7v.5 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  search: 'M21 21l-5-5 M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0',
  book: 'M12 5C8 2 3 4 3 4v15s5-2 9 1c4-3 9-1 9-1V4s-5-2-9 1z M12 5v15',
  layers: 'M12 3L2 8l10 5 10-5-10-5z M3 12l9 5 9-5 M3 16l9 5 9-5',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M6 6a8 8 0 0 1 13 3 M18 18a8 8 0 0 1-13-3',
  copy: 'M9 9h12v12H9z M15 9V3H3v12h6',
  bolt: 'M13 2L4 14h7l-1 8 10-12h-7l1-8z',
  globe: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0 M2 12h20 M12 2c5 5 5 15 0 20-5-5-5-15 0-20',
  cpu: 'M6 6h12v12H6z M9 9h6v6H9z M9 2v4 M15 2v4 M9 18v4 M15 18v4 M2 9h4 M2 15h4 M18 9h4 M18 15h4',
  server: 'M3 3h18v7H3z M3 14h18v7H3z M7 6.5h.1 M7 17.5h.1 M15 6.5h3 M15 17.5h3',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M10 2h4l1 3 3 1 3-1 2 4-2 2v3l2 2-2 4-3-1-3 1-1 3h-4l-1-3-3-1-3 1-2-4 2-2v-3L1 9l2-4 3 1 3-1 1-3z',
  sliders: 'M4 7h5 M15 7h5 M4 17h10 M20 17h-1 M12 4v6 M17 14v6',
  code: 'M8 6l-6 6 6 6 M16 6l6 6-6 6 M14 3l-4 18',
  file: 'M14 2H4v20h16V8l-6-6z M14 2v6h6 M8 13h8 M8 17h6',
  folder: 'M3 6h7l2 3h9v12H3V6z M3 6V3h7l2 3h9v3',
  chart: 'M4 3v17h17 M8 15V9 M13 15V5 M18 15v-4',
  edit: 'M16 3l5 5-12 12-6 1 1-6L16 3z M13 6l5 5',
  trash: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  archive: 'M3 3h18v5H3z M5 8v13h14V8 M10 12h4',
  save: 'M4 3h13l4 4v14H3V3h1z M7 3v6h10V3 M7 21v-8h10v8',
  lock: 'M5 10h14v12H5z M8 10V6a4 4 0 0 1 8 0v4 M12 15v3',
  logout: 'M9 3H3v18h6 M10 12h12 M17 7l5 5-5 5',
  plug: 'M8 2v5 M16 2v5 M5 7h14v3a7 7 0 0 1-14 0V7z M12 17v5',
  paperclip: 'M8 12l7-7a4 4 0 0 1 6 6L10 22a6 6 0 0 1-8-8L13 3 M6 16L17 5',
  panel: 'M3 4h18v16H3z M15 4v16 M18 8h.1 M18 12h.1',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  eyeOff:
    'M3 3l18 18 M10.5 5.2A12 12 0 0 1 12 5c6 0 10 7 10 7a18 18 0 0 1-3.2 4 M6 6.5A21 21 0 0 0 2 12s4 7 10 7a13 13 0 0 0 5-1 M9 9a4 4 0 0 0 6 6',
  wrench: 'M14 3a6 6 0 0 0-7 7L2 16a3 3 0 0 0 4 4l6-6a6 6 0 0 0 9-7l-4 4-4-4 3-4z',
  circle: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
};
</script>
<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.65"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] || paths.box" />
  </svg>
</template>
