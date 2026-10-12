<script setup lang="ts">
import EvolutionViewer from '~/components/EvolutionViewer.vue'
import ThreeScene from '~/components/ThreeScene.vue'
import EvolutionShowcaseButton from '~/components/EvolutionShowcaseButton.vue'
const { selectedGenemon } = useGenemonLab()
</script>

<template>
  <div class="col" style="height:100%">
    <div class="row" style="gap:8px">
      <button class="btn">3D</button>
      <button class="btn">Evolution</button>
      <EvolutionShowcaseButton />
    </div>
    <div class="divider" />
    <div class="row" style="height:100%; gap:16px">
      <div class="card" style="flex:1; height:420px">
        <ThreeScene />
      </div>
      <div class="card" style="flex:1; height:420px">
        <EvolutionViewer />
      </div>
    </div>
  </div>
</template>


