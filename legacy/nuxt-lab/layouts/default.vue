<script setup lang="ts">
import TopBar from '~/components/TopBar.vue'
import DataTree from '~/components/DataTree.vue'
import DetailEditor from '~/components/DetailEditor.vue'

const leftOpen = useState<boolean>('leftOpen', () => true)
const rightOpen = useState<boolean>('rightOpen', () => true)
const evolutionOpen = useState<boolean>('evolutionOpen', () => true)

function toggleLeft() { leftOpen.value = !leftOpen.value }
function toggleRight() { rightOpen.value = !rightOpen.value }
function toggleEvolution() { evolutionOpen.value = !evolutionOpen.value }
</script>

<template>
  <div class="app-root">
    <header class="topbar">
      <TopBar @toggle-left="toggleLeft" @toggle-right="toggleRight" @toggle-evolution="toggleEvolution" />
    </header>
    <main class="panels-flex">
      <aside v-if="leftOpen" class="panel left flex-panel">
        <div class="section-title">Data</div>
        <div class="divider" />
        <DataTree />
      </aside>
      <section class="panel center flex-panel-center">
        <slot />
      </section>
      <aside v-if="evolutionOpen" class="panel evolution flex-panel-evolution">
        <div class="section-title">Evolution Timeline</div>
        <div class="divider" />
        <LazyEvolutionTimeline />
      </aside>
      <aside v-if="rightOpen" class="panel right flex-panel">
        <div class="section-title">Details</div>
        <div class="divider" />
        <DetailEditor />
      </aside>
    </main>
  </div>
</template>


