<script setup lang="ts">
const svgRef = ref<SVGSVGElement | null>(null)
const lon = ref(2.3522)
const lat = ref(48.8566)
const alt = ref(0)
const pathPoints = ref<Array<{lon:number;lat:number;alt:number}>>([])

function addPoint() {
  pathPoints.value.push({ lon: lon.value, lat: lat.value, alt: alt.value })
}
function clearPath() { pathPoints.value = [] }

function project(lon: number, lat: number) {
  // equirectangular projection into the SVG viewBox (1000x500)
  const x = ((lon + 180) / 360) * 1000
  const y = ((90 - lat) / 180) * 500
  return { x, y }
}

const d = computed(() => {
  if (pathPoints.value.length === 0) return ''
  return pathPoints.value.map((p, i) => {
    const { x, y } = project(p.lon, p.lat)
    return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
  }).join(' ')
})

function rFromAlt(a: number) {
  const base = 4
  const scaled = base + a * 0.3
  return Math.max(3, Math.min(12, scaled))
}
</script>

<template>
  <div class="col">
    <div class="row">
      <input class="input" type="number" step="0.0001" v-model.number="lon" placeholder="lon (x)" />
      <input class="input" type="number" step="0.0001" v-model.number="lat" placeholder="lat (y)" />
      <input class="input" type="number" step="0.1" v-model.number="alt" placeholder="alt (z)" />
      <button class="btn" @click="addPoint">Add</button>
      <button class="btn" @click="clearPath">Clear</button>
    </div>
    <div class="card" style="padding:0; overflow:hidden;">
      <svg ref="svgRef" viewBox="0 0 1000 500" style="display:block; width:100%; height:420px; background:url('/world.svg') center/cover no-repeat;">
        <path :d="d" stroke="#5ad7ff" stroke-width="3" fill="none" stroke-linecap="round" />
        <g>
          <circle v-for="(p, i) in pathPoints" :key="i" :cx="project(p.lon,p.lat).x" :cy="project(p.lon,p.lat).y" :r="rFromAlt(p.alt)" fill="#a77bff" />
          <text v-for="(p, i) in pathPoints" :key="'t'+i" :x="project(p.lon,p.lat).x + 6" :y="project(p.lon,p.lat).y - 6" fill="#96a0b5" font-size="10">{{ p.alt.toFixed(1) }}m</text>
        </g>
      </svg>
    </div>
  </div>
  
</template>


