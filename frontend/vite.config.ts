import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { AntDesignVueResolver } from 'unplugin-vue-components/resolvers';
import { defineConfig, type Plugin } from 'vite';

/**
 * 当前主题的品牌色（500 档，不带 #），读取 styles/themes/_index.scss 选中的主题文件。
 * index.html 在 JS 之前就要用到（标签页图标、theme-color），无法使用 CSS 变量，因此在构建 / 开发服务时替换。
 */
function activeThemeBrandHex(): string {
  const dir = fileURLToPath(new URL('./src/styles/themes/', import.meta.url));
  const name = /@forward\s+['"]([\w-]+)['"]/.exec(readFileSync(`${dir}_index.scss`, 'utf8'))?.[1];
  const scale = name
    ? /\$brand:\s*\(([\s\S]*?)\);/.exec(readFileSync(`${dir}_${name}.scss`, 'utf8'))?.[1]
    : '';
  const hex = scale ? /\b500:\s*#([0-9a-fA-F]{6})\b/.exec(scale)?.[1] : undefined;
  if (!hex) throw new Error('无法从 styles/themes/_index.scss 解析当前主题的品牌色（$brand 的 500 档）');
  return hex.toLowerCase();
}

/** 把 index.html 里的 __FORGE_BRAND_HEX__ 换成当前主题品牌色；开发时每次请求重新读取，改主题后刷新即可。 */
function forgeThemeHtml(): Plugin {
  return {
    name: 'forge-theme-html',
    transformIndexHtml: (html) => html.replaceAll('__FORGE_BRAND_HEX__', activeThemeBrandHex()),
  };
}

export default defineConfig({
  plugins: [
    forgeThemeHtml(),
    vue(),
    Components({
      // ant-design-vue 按需自动导入：模板里写 <a-xxx> 即可，无需逐文件 import，且仍 tree-shake。
      resolvers: [AntDesignVueResolver({ importStyle: false })],
      // 不自动解析本地组件（ForgeIcon/DialogShell 等仍显式 import，避免误抓）。
      dirs: [],
      // 生成全局组件类型声明，供 vue-tsc 识别 <a-xxx> 标签。
      dts: 'src/components.d.ts',
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1'],
    // 本地开发默认开启 HMR，前端改动即时热更；E2B 沙箱里可 FORGE_NO_HMR=1 关闭。
    hmr: process.env.FORGE_NO_HMR === '1' ? false : true,
    proxy: {
      // 控制面（浏览器不直连 runner；SSE 也经控制面/流网关）
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
});
