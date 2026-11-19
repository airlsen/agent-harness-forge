import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { AntDesignVueResolver } from 'unplugin-vue-components/resolvers';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
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
