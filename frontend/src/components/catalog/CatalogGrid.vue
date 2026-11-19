<template>
  <!-- 每行最多 3 张；单张窄于 280px 时自动降为 2 列 / 1 列，不依赖视口断点 -->
  <div class="catalog-grid"><slot /></div>
</template>

<style scoped>
.catalog-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, max(280px, calc((100% - 36px) / 3))), 1fr));
  gap: 18px;
}
</style>
