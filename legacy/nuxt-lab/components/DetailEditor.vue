<script setup lang="ts">
const { selectedGenemon, upsert } = useGenemonLab()

function update<K extends keyof NonNullable<typeof selectedGenemon.value>>(key: K, value: any) {
  if (!selectedGenemon.value) return
  const updated = structuredClone(selectedGenemon.value)
  ;(updated as any)[key] = value
  upsert(updated)
}
</script>

<template>
  <div v-if="selectedGenemon" class="col">
    <div class="form-grid">
      <div class="full">
        <label>Name</label>
        <input class="input" :value="selectedGenemon.name" @input="update('name', ($event.target as HTMLInputElement).value)" />
      </div>
      <div>
        <label>Primary Type</label>
        <select class="input" :value="selectedGenemon.types.primary" @change="update('types', { ...selectedGenemon.types, primary: ($event.target as HTMLSelectElement).value })">
          <option value="neutral">neutral</option>
          <option value="water">water</option>
          <option value="fire">fire</option>
          <option value="earth">earth</option>
          <option value="air">air</option>
          <option value="electric">electric</option>
          <option value="ice">ice</option>
          <option value="poison">poison</option>
          <option value="plant">plant</option>
          <option value="metal">metal</option>
          <option value="psychic">psychic</option>
          <option value="shadow">shadow</option>
          <option value="light">light</option>
          <option value="steam">steam</option>
          <option value="magma">magma</option>
          <option value="toxin">toxin</option>
          <option value="crystal">crystal</option>
        </select>
      </div>
      <div>
        <label>Secondary Type</label>
        <select class="input" :value="selectedGenemon.types.secondary || ''" @change="update('types', { ...selectedGenemon.types, secondary: ($event.target as HTMLSelectElement).value || null })">
          <option value="">none</option>
          <option value="water">water</option>
          <option value="fire">fire</option>
          <option value="earth">earth</option>
          <option value="air">air</option>
          <option value="electric">electric</option>
          <option value="ice">ice</option>
          <option value="poison">poison</option>
          <option value="plant">plant</option>
          <option value="metal">metal</option>
          <option value="psychic">psychic</option>
          <option value="shadow">shadow</option>
          <option value="light">light</option>
          <option value="steam">steam</option>
          <option value="magma">magma</option>
          <option value="toxin">toxin</option>
          <option value="crystal">crystal</option>
        </select>
      </div>
      <div>
        <label>Growth (t)</label>
        <input class="input" type="range" min="0" max="1" step="0.01" :value="selectedGenemon.state.growthT" @input="update('state', { ...selectedGenemon.state, growthT: Number(($event.target as HTMLInputElement).value) })" />
      </div>
      <div>
        <label>Mass (kg)</label>
        <input class="input" type="number" :value="selectedGenemon.physiology.massKg" @input="update('physiology', { ...selectedGenemon.physiology, massKg: Number(($event.target as HTMLInputElement).value) })" />
      </div>
      <div>
        <label>Energy</label>
        <input class="input" type="number" min="0" max="1" step="0.01" :value="selectedGenemon.physiology.energyReserve" @input="update('physiology', { ...selectedGenemon.physiology, energyReserve: Number(($event.target as HTMLInputElement).value) })" />
      </div>
      <div class="full">
        <label>Timeline (Stages)</label>
        <div class="row">
          <input class="input" type="number" min="0" max="1" step="0.01" :value="selectedGenemon.timeline?.lifeStages.baby ?? 0" @input="update('timeline', { ...(selectedGenemon.timeline||{lifeStages:{baby:0,juvenile:0.3,adult:0.6}}), lifeStages: { ...(selectedGenemon.timeline?.lifeStages||{}), baby: Number(($event.target as HTMLInputElement).value) } })" />
          <input class="input" type="number" min="0" max="1" step="0.01" :value="selectedGenemon.timeline?.lifeStages.juvenile ?? 0.3" @input="update('timeline', { ...(selectedGenemon.timeline||{lifeStages:{baby:0,juvenile:0.3,adult:0.6}}), lifeStages: { ...(selectedGenemon.timeline?.lifeStages||{}), juvenile: Number(($event.target as HTMLInputElement).value) } })" />
          <input class="input" type="number" min="0" max="1" step="0.01" :value="selectedGenemon.timeline?.lifeStages.adult ?? 0.6" @input="update('timeline', { ...(selectedGenemon.timeline||{lifeStages:{baby:0,juvenile:0.3,adult:0.6}}), lifeStages: { ...(selectedGenemon.timeline?.lifeStages||{}), adult: Number(($event.target as HTMLInputElement).value) } })" />
        </div>
      </div>
    </div>
  </div>
  <div v-else>
    <em>No genemon selected.</em>
  </div>
</template>


