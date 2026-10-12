<script setup lang="ts">
import * as THREE from 'three'

const { selectedGenemon, upsert } = useGenemonLab()
const generating = ref(false)

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let cube: THREE.Mesh | null = null

function init(width = 640, height = 360) {
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0b0f14)
  camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100)
  camera.position.set(3, 2, 3)
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
  renderer.setSize(width, height)
  const light = new THREE.DirectionalLight(0xffffff, 1)
  light.position.set(3, 5, 2)
  scene.add(new THREE.AmbientLight(0x404040))
  scene.add(light)
  const grid = new THREE.GridHelper(10, 10, 0x223344, 0x1a2033)
  ;(grid.material as THREE.Material).transparent = true
  scene.add(grid)
  const geo = new THREE.SphereGeometry(0.6, 32, 16)
  const mat = new THREE.MeshStandardMaterial({ color: 0xa77bff })
  cube = new THREE.Mesh(geo, mat)
  scene.add(cube)
}

async function generate() {
  if (!selectedGenemon.value || generating.value) return
  generating.value = true
  try {
    init()
    if (!renderer || !scene || !camera || !cube) return
    const canvas = renderer.domElement
    const stream = (canvas as HTMLCanvasElement).captureStream(60)
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp9' })
    const chunks: BlobPart[] = []
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
    const done = new Promise<void>((resolve) => { recorder.onstop = () => resolve() })
    recorder.start()

    const start = performance.now()
    const duration = 5000
    let raf = 0
    const loop = () => {
      const now = performance.now()
      const t = Math.min(1, (now - start) / duration)
      // Update global growthT for UI syncing
      const g = structuredClone(selectedGenemon.value!)
      g.state.growthT = t
      upsert(g)
      // Animate scene
      if (cube) {
        cube.rotation.y += 0.02
        const s = 0.5 + t
        cube.scale.setScalar(s)
      }
      renderer!.render(scene!, camera!)
      if (t < 1) raf = requestAnimationFrame(loop)
      else recorder.stop()
    }
    loop()
    await done
    cancelAnimationFrame(raf)
    const blob = new Blob(chunks, { type: 'video/webm' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${selectedGenemon.value!.name.replace(/\s+/g,'_')}_evolution.webm`
    a.click()
    URL.revokeObjectURL(url)
  } finally {
    generating.value = false
    renderer?.dispose?.()
    renderer = null
    scene = null
    camera = null
    cube = null
  }
}
</script>

<template>
  <button class="btn" :disabled="!selectedGenemon || generating" @click="generate">
    {{ generating ? 'Generating…' : 'Generate Evolution Video' }}
  </button>
</template>


