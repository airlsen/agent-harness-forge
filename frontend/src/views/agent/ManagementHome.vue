<script setup lang="ts">
import { usePlatform } from '../../stores/platform';
import Icon from '../../components/ForgeIcon.vue';
const app = usePlatform();
</script>
<template>
  <main class="page-content enterprise-page management-home">
    <div class="enterprise-page-inner">
      <div class="page-heading">
        <div>
          <h1>平台管理</h1>
          <p>统一维护连接与执行策略，让公共能力可靠地服务工作。</p>
        </div>
        <RouterLink class="button secondary" to="/agent/workbench"
          ><Icon name="arrowLeft" :size="15" />返回工作台</RouterLink
        >
      </div>
      <div class="management-banner">
        <span class="management-banner-icon"><Icon name="building" :size="26" /></span>
        <div>
          <h2>统一维护，不必让每位员工重复配置。</h2>
          <p>这里管理平台级连接与规则。公共能力的发现和使用，仍在企业场景与能力中心。</p>
        </div>
      </div>
      <div class="management-card-grid">
        <RouterLink to="/agent/models" class="management-card"
          ><span class="scene-icon code"><Icon name="cpu" :size="23" /></span
          ><span :class="['tag', app.connection?.configured ? 'success' : 'warning']">{{
            app.connection?.configured ? '已配置' : '待配置'
          }}</span>
          <h2>模型连接</h2>
          <p>配置模型网关、托管访问密钥，测试真实连接。</p>
          <footer>
            <span>{{ app.connection?.model || '尚未连接模型' }}</span><Icon name="arrow" :size="17" /></footer
        ></RouterLink>
        <RouterLink to="/agent/governance" class="management-card"
          ><span class="scene-icon shield"><Icon name="shield" :size="23" /></span>
          <h2>企业策略</h2>
          <p>维护可执行工具范围、写入审批与运行边界。</p>
          <footer><span>规则变更作用于新会话</span><Icon name="arrow" :size="17" /></footer
        ></RouterLink>
        <RouterLink to="/agent/audit" class="management-card"
          ><span class="scene-icon file"><Icon name="activity" :size="23" /></span>
          <h2>运行审计</h2>
          <p>检查实际执行记录、用量和异常，进入轨迹定位问题。</p>
          <footer><span>基于真实会话事件</span><Icon name="arrow" :size="17" /></footer
        ></RouterLink>
      </div>
      <section class="management-section">
        <div>
          <h2>公共资产维护</h2>
          <p>使用与维护共用同一份资源目录，不复制出个人资源库。</p>
        </div>
        <div class="management-resource-links">
          <RouterLink to="/agent/scenarios?view=maintain"
            ><Icon name="grid" :size="20" />
            <div><strong>场景维护</strong><small>编辑、版本、试运行与发布</small></div>
            <Icon name="arrow" :size="16" /></RouterLink
          ><RouterLink to="/agent/capabilities"
            ><Icon name="blocks" :size="20" />
            <div><strong>能力目录</strong><small>查看已接入工具与后续接入边界</small></div>
            <Icon name="arrow" :size="16"
          /></RouterLink>
        </div>
      </section>
      <div class="release-boundary">
        <Icon name="users" :size="21" />
        <div>
          <strong>成员身份与权限：尚未接入</strong>
          <p>
            当前使用单管理员认证，不具备员工间会话访问隔离。企业
            SSO、多用户归属和服务端权限校验属于下一阶段，不提供模拟邀请或假权限开关。
          </p>
        </div>
      </div>
      <details class="runtime-details">
        <summary>
          <Icon name="server" :size="16" /><span>运行信息与部署边界</span
          ><Icon name="chevronDown" :size="15" />
        </summary>
        <div>
          <dl>
            <div>
              <dt>控制面</dt>
              <dd>{{ app.runtime?.controlPlane || '正在读取' }}</dd>
            </div>
            <div>
              <dt>执行服务</dt>
              <dd>{{ app.runtime?.runner.status === 'online' ? '在线' : '离线或不可达' }}</dd>
            </div>
            <div>
              <dt>执行容量</dt>
              <dd>{{ app.runtime?.runner.capacity ?? '未知' }}</dd>
            </div>
            <div>
              <dt>存储</dt>
              <dd>{{ app.runtime?.storage || '正在读取' }}</dd>
            </div>
          </dl>
          <ul>
            <li v-for="limit in app.runtime?.limitations" :key="limit">{{ limit }}</li>
          </ul>
        </div>
      </details>
    </div>
  </main>
</template>
