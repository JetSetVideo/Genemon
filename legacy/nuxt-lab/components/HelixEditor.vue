<script setup lang="ts">
const { selectedGenemon, upsert } = useGenemonLab()

function randomizeGene(i: number) {
  if (!selectedGenemon.value?.genotype) return
  const g = structuredClone(selectedGenemon.value)
  g.genotype!.strandA[i] = +(Math.random() * 2).toFixed(3)
  g.genotype!.strandB[i] = +(-Math.random()).toFixed(3)
  upsert(g)
}

function regenSeeds() {
  if (!selectedGenemon.value) return
  const g = structuredClone(selectedGenemon.value)
  g.seeds.genotypeSeed = Math.floor(Math.random() * 1e9)
  g.seeds.environmentSeed = Math.floor(Math.random() * 1e9)
  upsert(g)
}
</script>

<template>
  <div class="col">
    <div class="row">
      <button class="btn" @click="regenSeeds">Generate New Seeds</button>
    </div>
    <div class="divider" />
    <div v-if="selectedGenemon?.genotype" class="col" style="gap:6px; max-height: 380px; overflow:auto;">
      <div v-for="i in selectedGenemon.genotype.length" :key="i" class="row" style="align-items:center; gap:8px;">
        <div style="width:64px; opacity:.7">G-{{ (i-1).toString().padStart(3,'0') }}</div>
        <div class="row" style="flex:1; gap:6px; align-items:center;">
          <input class="input" type="number" step="0.001" :value="selectedGenemon.genotype.strandA[i-1]" />
          <input class="input" type="number" step="0.001" :value="selectedGenemon.genotype.strandB[i-1]" />
        </div>
        <button class="btn" @click="randomizeGene(i-1)">Randomize</button>
      </div>
    </div>
    <div v-else><em>No genotype found for selection.</em></div>
  </div>
</template>


