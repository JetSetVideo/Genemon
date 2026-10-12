<script setup lang="ts">
import type { Genemon } from '~/types/genemon'
const { genemons } = useGenemonLab()

const parentA = ref<Genemon | null>(null)
const parentB = ref<Genemon | null>(null)
const child = ref<Genemon | null>(null)

function pickA(id: string) { parentA.value = genemons.value.find(g => g.id === id) || null }
function pickB(id: string) { parentB.value = genemons.value.find(g => g.id === id) || null }

function crossoverAndMutate() {
  if (!parentA.value?.genotype || !parentB.value?.genotype) return
  const len = Math.min(parentA.value.genotype.length, parentB.value.genotype.length)
  const aA = parentA.value.genotype.strandA
  const aB = parentA.value.genotype.strandB
  const bA = parentB.value.genotype.strandA
  const bB = parentB.value.genotype.strandB
  const cA: number[] = []
  const cB: number[] = []
  for (let i = 0; i < len; i++) {
    const fromA = Math.random() < 0.5
    cA[i] = fromA ? aA[i] : bA[i]
    cB[i] = fromA ? aB[i] : bB[i]
    if (Math.random() < 0.005) { cA[i] += (Math.random() - 0.5) * 0.1 }
    if (Math.random() < 0.005) { cB[i] += (Math.random() - 0.5) * 0.1 }
  }
  child.value = {
    id: `gm_child_${Date.now()}`,
    name: 'Progeny',
    seeds: { genotypeSeed: Math.floor(Math.random() * 1e9), environmentSeed: Math.floor(Math.random() * 1e9) },
    genotype: { length: len, strandA: cA, strandB: cB },
    taxonomy: { inspirations: [], category: 'hybrid' },
    types: { primary: 'neutral', secondary: null, secondaryLevel: 0 },
    morphology: { bodySegments: 5, limbs: { count: 4, types: ['leg','leg','arm','arm'] }, hasTail: false, hasWings: false },
    physiology: { sizeClass: 'S', massKg: 5, digestion: 'omnivore', energyReserve: 0.5, sleepPattern: 'diurnal' },
    senses: { vision: 'normal', nightVision: false, smell: 'normal', hearing: 'normal' },
    reproduction: { sex: 'unknown', strategy: 'sexual', potentialOffsprings: [1,3] },
    intelligence: { level: 0.2, traits: [] },
    temperament: { traits: ['curious'] },
    colors: { palette: ['#88ccff', '#223344'], pattern: 'mottle' },
    growthCurves: { overall: 'sigmoid', segments: [0.2,0.25,0.3,0.35,0.4], limbGrowth: [0.2,0.25,0.3,0.35], specializationRules: [] },
    environment: { biomes: ['temperate-forest'], climate: 'temperate' },
    attacks: [],
    animation: { canWalk: true, canRun: true, canSwim: false, canFly: false },
    stats: { hp: 30, attack: 8, defense: 6, speed: 7 },
    statsPotential: { hp: 60, attack: 15, defense: 12, speed: 14 },
    timeline: { lifeStages: { baby: 0, juvenile: 0.3, adult: 0.6 }, events: [] },
    state: { growthT: 0 }
  }
}
</script>

<template>
  <div class="col">
    <div class="row">
      <select class="input" @change="pickA(($event.target as HTMLSelectElement).value)">
        <option value="">Parent A</option>
        <option v-for="g in genemons" :key="g.id" :value="g.id">{{ g.name }}</option>
      </select>
      <select class="input" @change="pickB(($event.target as HTMLSelectElement).value)">
        <option value="">Parent B</option>
        <option v-for="g in genemons" :key="g.id" :value="g.id">{{ g.name }}</option>
      </select>
      <button class="btn" @click="crossoverAndMutate" :disabled="!parentA || !parentB">Generate Child</button>
    </div>
    <div class="divider" />
    <div v-if="child" class="card">
      <div><strong>ID:</strong> {{ child.id }}</div>
      <div><strong>Genes:</strong> {{ child.genotype?.length }} pairs</div>
    </div>
  </div>
</template>


