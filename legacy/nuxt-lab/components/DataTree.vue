<script setup lang="ts">
const { genemons, selectedGenemonId, select, loadFromFiles, createNew, remove, exportSelected } = useGenemonLab()
onMounted(loadFromFiles)

function onCreate() {
  createNew()
}
function onDelete() {
  if (selectedGenemonId.value) remove(selectedGenemonId.value)
}
</script>

<template>
  <div class="col">
    <div class="row">
      <button class="btn" @click="onCreate">New</button>
      <button class="btn" @click="loadFromFiles">Reload</button>
      <button class="btn" :disabled="!selectedGenemonId" @click="exportSelected">Export</button>
      <button class="btn" :disabled="!selectedGenemonId" @click="onDelete">Delete</button>
    </div>
    <div class="divider" />
    <div class="tree">
      <ul>
        <li v-for="g in genemons" :key="g.id">
          <div class="node" :style="{fontWeight: g.id===selectedGenemonId ? '600' : '400'}" @click="select(g.id)">
            <span>🧬</span>
            <span>{{ g.name }}</span>
          </div>
        </li>
      </ul>
    </div>
    <div class="divider" />
    <div>
      <div class="section-title">Genotype Tools</div>
      <NuxtLink to="/breeding" class="btn" style="margin-top:8px; display:inline-block;">Open Breeding Simulator</NuxtLink>
      <div style="margin-top:8px;">
        <HelixEditor />
      </div>
    </div>
  </div>
</template>


