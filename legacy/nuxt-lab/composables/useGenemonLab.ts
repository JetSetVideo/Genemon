import type { Genemon } from '~/types/genemon'

type GenemonId = string

export function useGenemonLab() {
  const genemons = useState<Genemon[]>('genemons', () => [])
  const selectedGenemonId = useState<GenemonId | null>('selectedGenemonId', () => null)
  const selectedGenemon = computed(() => genemons.value.find(g => g.id === selectedGenemonId.value) || null)

  async function loadFromFiles() {
    const modules = import.meta.glob('~/data/genemons/*.json', { eager: true, import: 'default' }) as Record<string, Genemon>
    const loaded: Genemon[] = []
    for (const path in modules) {
      const raw = modules[path]
      if (raw && (raw as any).id) loaded.push(raw as Genemon)
    }
    // Sort stable for UX
    loaded.sort((a, b) => a.name.localeCompare(b.name))
    genemons.value = loaded
    if (!selectedGenemonId.value && loaded.length) selectedGenemonId.value = loaded[0].id
  }

  function select(id: GenemonId) {
    selectedGenemonId.value = id
  }

  function upsert(updated: Genemon) {
    const index = genemons.value.findIndex(g => g.id === updated.id)
    if (index >= 0) genemons.value[index] = structuredClone(updated)
    else genemons.value.push(structuredClone(updated))
  }

  function remove(id: GenemonId) {
    const index = genemons.value.findIndex(g => g.id === id)
    if (index >= 0) genemons.value.splice(index, 1)
    if (selectedGenemonId.value === id) selectedGenemonId.value = genemons.value[0]?.id ?? null
  }

  function createNew(base?: Partial<Genemon>) {
    const now = Date.now()
    const id = `gm_${now}`
    const newborn: Genemon = {
      id,
      name: base?.name || 'New Genemon',
      seeds: { genotypeSeed: Math.floor(Math.random() * 1e9), environmentSeed: Math.floor(Math.random() * 1e9) },
      taxonomy: { inspirations: [], category: 'hybrid' },
      types: { primary: 'neutral', secondary: null, secondaryLevel: 0 },
      morphology: { bodySegments: 5, limbs: { count: 4, types: ['leg','leg','arm','arm'] }, hasTail: false, hasWings: false },
      physiology: { sizeClass: 'S', massKg: 5, digestion: 'omnivore', energyReserve: 0.5, sleepPattern: 'diurnal' },
      senses: { vision: 'normal', nightVision: false, smell: 'normal', hearing: 'normal' },
      reproduction: { sex: 'unknown', strategy: 'sexual', potentialOffsprings: [1,3] },
      intelligence: { level: 0.2, traits: [] },
      temperament: { traits: ['curious'] },
      colors: { palette: ['#88ccff', '#223344'], pattern: 'mottle' },
      growthCurves: {
        overall: 'sigmoid',
        segments: [0.2,0.25,0.3,0.35,0.4],
        limbGrowth: [0.2,0.25,0.3,0.35],
        specializationRules: []
      },
      environment: { biomes: ['temperate-forest'], climate: 'temperate' },
      attacks: [],
      animation: { canWalk: true, canRun: true, canSwim: false, canFly: false },
      stats: { hp: 30, attack: 8, defense: 6, speed: 7 },
      state: { growthT: 0 }
    }
    upsert({ ...newborn, ...base })
    select(id)
  }

  function exportSelected() {
    if (!selectedGenemon.value) return
    const data = JSON.stringify(selectedGenemon.value, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${selectedGenemon.value.name.replace(/\s+/g,'_')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return { genemons, selectedGenemonId, selectedGenemon, loadFromFiles, select, upsert, remove, createNew, exportSelected }
}


