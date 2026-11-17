import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'remixicon/fonts/remixicon.css'
import AgentChat from './views/agent/AgentChat.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/agent/chat' },
    { path: '/agent/chat/:sessionId?', component: AgentChat },
    // TODO(W3): /agent/scenarios /agent/trajectory/:id …（页面地图见 docs/04）
  ],
})

createApp(AgentChat).use(createPinia()).use(router).use(ElementPlus).mount('#app')
