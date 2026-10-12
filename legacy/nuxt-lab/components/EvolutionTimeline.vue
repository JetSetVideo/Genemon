<script setup lang="ts">
const { selectedGenemon, upsert } = useGenemonLab()
const width = 1000
const height = 120

function setT(t: number) {
  if (!selectedGenemon.value) return
  const next = structuredClone(selectedGenemon.value)
  next.state.growthT = Math.min(1, Math.max(0, t))
  upsert(next)
}

function xFromT(t: number) { return 20 + t * (width - 40) }

const onClick = (e: MouseEvent) => {
  const svg = e.currentTarget as SVGSVGElement
  const rect = svg.getBoundingClientRect()
  const x = e.clientX - rect.left
  const t = (x - 20) / (width - 40)
  setT(t)
}
</script>

<template>
  <div class="card" style="height:120px; padding:0; overflow:hidden;">
    <svg :viewBox="`0 0 ${width} ${height}`" style="width:100%; height:100%; display:block;" @click="onClick">
      <rect x="0" y="0" :width="width" :height="height" fill="#0f1421"/>
      <line x1="20" y1="60" :x2="width-20" y2="60" stroke="#26324a" stroke-width="2"/>
      <template v-if="selectedGenemon?.timeline">
        <g stroke="#36446a" stroke-width="1">
          <line v-for="(v,k) in selectedGenemon.timeline.lifeStages" :key="k" :x1="xFromT(v as number)" y1="20" :x2="xFromT(v as number)" y2="100" />
        </g>
        <g fill="#96a0b5" font-size="10">
          <text x="20" y="18">Birth</text>
          <text v-for="(v,k) in selectedGenemon.timeline.lifeStages" :key="k" :x="xFromT(v as number)+4" y="18">{{ k }}</text>
          <text :x="width-48" y="18">Max</text>
        </g>
        <g>
          <circle v-for="(ev, i) in selectedGenemon.timeline.events" :key="i" :cx="xFromT(ev.t)" cy="60" r="5" fill="#5ad7ff" />
        </g>
      </template>
      <g v-if="selectedGenemon">
        <circle :cx="xFromT(selectedGenemon.state.growthT)" cy="60" r="8" fill="#a77bff" />
      </g>
    </svg>
  </div>
</template>


