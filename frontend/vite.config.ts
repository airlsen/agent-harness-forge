import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // 控制面（浏览器不直连 runner；SSE 也经控制面/流网关）
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
})
