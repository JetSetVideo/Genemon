<script setup lang="ts">
const emit = defineEmits<{ (e: 'toggle-left'): void; (e: 'toggle-right'): void; (e: 'toggle-evolution'): void }>()
const route = useRoute()
const { selectedGenemon } = useGenemonLab()
</script>

<template>
  <div class="toolbar" style="width:100%">
    <div class="row" style="align-items:center; gap:8px;">
      <nav class="nav">
        <NuxtLink to="/creator">Creator</NuxtLink>
        <NuxtLink to="/arena">Arena</NuxtLink>
        <NuxtLink to="/map">Map</NuxtLink>
        <NuxtLink to="/users">Users</NuxtLink>
      </nav>
    </div>
    <div style="text-align:center; flex:1; font-weight:600">{{ selectedGenemon?.name || 'No Selection' }}</div>
    <div class="row" style="align-items:center; gap:8px;">
      <div class="row" style="gap:6px">
        <button class="btn ghost" title="Toggle Left Panel" @click="emit('toggle-left')">◧</button>
        <button class="btn ghost" title="Toggle Evolution" @click="emit('toggle-evolution')">⧗</button>
        <button class="btn ghost" title="Toggle Right Panel" @click="emit('toggle-right')">◨</button>
      </div>
      <span style="opacity:.7; font-size:12px">{{ route.path }}</span>
    </div>
  </div>
</template>


