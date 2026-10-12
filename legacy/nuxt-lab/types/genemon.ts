export type ElementType = 'neutral' | 'water' | 'fire' | 'earth' | 'air' | 'electric' | 'ice' | 'poison' | 'plant' | 'metal' | 'psychic' | 'shadow' | 'light' | 'steam' | 'magma' | 'toxin' | 'crystal'

export interface Genemon {
  id: string
  name: string
  seeds: { genotypeSeed: number; environmentSeed: number }
  genotype?: {
    length: number
    strandA: number[]
    strandB: number[]
    geneMap?: Array<{ index: number; trait: string }>
  }
  taxonomy: { inspirations: string[]; category: 'animal' | 'object' | 'hybrid' }
  types: { primary: ElementType; secondary: ElementType | null; secondaryLevel: number }
  morphology: {
    bodySegments: number
    limbs: { count: number; types: string[] }
    hasTail: boolean
    hasWings: boolean
  }
  physiology: {
    sizeClass: 'XS' | 'S' | 'M' | 'L' | 'XL'
    massKg: number
    digestion: 'herbivore' | 'carnivore' | 'omnivore' | 'detritivore'
    energyReserve: number
    sleepPattern: 'diurnal' | 'nocturnal' | 'crepuscular'
  }
  senses: { vision: 'poor' | 'normal' | 'sharp'; nightVision: boolean; smell: 'poor' | 'normal' | 'sharp'; hearing: 'poor' | 'normal' | 'sharp' }
  reproduction: { sex: 'male' | 'female' | 'asexual' | 'unknown'; strategy: 'sexual' | 'asexual' | 'spores'; potentialOffsprings: [number, number] }
  intelligence: { level: number; traits: string[] }
  temperament: { traits: string[] }
  colors: { palette: string[]; pattern: 'solid' | 'stripe' | 'mottle' | 'spot' }
  growthCurves: {
    overall: 'linear' | 'sigmoid' | 'logistic'
    segments: number[]
    limbGrowth: number[]
    specializationRules: Array<{ whenGrowthAbove: number; addTrait?: string; unlockLimb?: string; changeTypeSecondary?: ElementType }>
  }
  environment: { biomes: string[]; climate: 'tropical' | 'temperate' | 'arid' | 'polar' | 'montane' }
  attacks: Array<{ name: string; element: ElementType; basePower: number }>
  animation: { canWalk: boolean; canRun: boolean; canSwim: boolean; canFly: boolean }
  stats: { hp: number; attack: number; defense: number; speed: number }
  statsPotential?: { hp: number; attack: number; defense: number; speed: number }
  timeline?: {
    lifeStages: { baby: number; juvenile: number; adult: number; elder?: number }
    events: Array<{ t: number; type: string; label: string; value?: number; meta?: Record<string, any> }>
  }
  state: { growthT: number }
}


