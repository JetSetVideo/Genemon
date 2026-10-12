<script setup lang="ts">
import * as THREE from 'three'
const { selectedGenemon } = useGenemonLab()

const container = ref<HTMLDivElement | null>(null)
let renderer: THREE.WebGLRenderer
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let frameId = 0
let startTime = 0

function createSkeletonMesh(t: number) {
  const group = new THREE.Group()
  const segments = 6
  const baseScale = THREE.MathUtils.lerp(0.4, 1.4, t)
  for (let i = 0; i < segments; i++) {
    const r = THREE.MathUtils.lerp(0.2, 0.5, i / (segments - 1)) * baseScale
    const g = new THREE.SphereGeometry(r, 24, 16)
    const color = new THREE.Color().setHSL(0.55 + 0.1 * t, 0.8, 0.6)
    const m = new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.6 })
    const s = new THREE.Mesh(g, m)
    s.position.set(0, i * (0.35 * baseScale), 0)
    group.add(s)
    if (i > 0) {
      const cyl = new THREE.CylinderGeometry(0.08 * baseScale, 0.12 * baseScale, 0.35 * baseScale, 12)
      const cm = new THREE.MeshStandardMaterial({ color: 0x88aadd })
      const bone = new THREE.Mesh(cyl, cm)
      bone.position.set(0, i * (0.35 * baseScale) - (0.175 * baseScale), 0)
      group.add(bone)
    }
  }
  // simple limb growth
  const limbLen = THREE.MathUtils.lerp(0.2, 0.9, t)
  const limb = new THREE.CylinderGeometry(0.06 * baseScale, 0.06 * baseScale, limbLen, 10)
  const lm = new THREE.MeshStandardMaterial({ color: 0x5ad7ff })
  for (const side of [-1, 1]) {
    const l = new THREE.Mesh(limb, lm)
    l.position.set(0.3 * side * baseScale, 0.7 * baseScale, 0)
    l.rotation.z = Math.PI / 2
    group.add(l)
  }
  return group
}

function init() {
  if (!container.value) return
  const w = container.value.clientWidth
  const h = container.value.clientHeight
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0b0f14)
  camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100)
  camera.position.set(3, 2, 3)
  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(w, h)
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
  container.value.appendChild(renderer.domElement)

  scene.add(new THREE.AmbientLight(0x404040))
  const dl = new THREE.DirectionalLight(0xffffff, 1)
  dl.position.set(3, 5, 2)
  scene.add(dl)

  const grid = new THREE.GridHelper(10, 10, 0x223344, 0x1a2033)
  scene.add(grid)

  startTime = performance.now()
  const animate = () => {
    const now = performance.now()
    const elapsed = (now - startTime) / 1000
    // 5-second evolution from t=0 to t=1
    const t = Math.min(1, elapsed / 5)

    // orbit camera
    const angle = elapsed * 0.6
    const radius = 3.2
    camera.position.set(Math.cos(angle) * radius, 1.8, Math.sin(angle) * radius)
    camera.lookAt(0, 1, 0)

    // rebuild simple skeleton each frame (cheap)
    for (let i = scene.children.length - 1; i >= 0; i--) {
      const child = scene.children[i]
      if ((child as any).isMesh || (child as any).type === 'Group') {
        scene.remove(child)
      }
    }
    // keep lights and grid
    scene.add(grid)
    scene.add(dl)
    scene.add(new THREE.AmbientLight(0x404040))
    const g = createSkeletonMesh(t)
    scene.add(g)

    renderer.render(scene, camera)
    frameId = requestAnimationFrame(animate)
  }
  animate()
}

onMounted(init)
onBeforeUnmount(() => { cancelAnimationFrame(frameId); renderer?.dispose?.(); })
</script>

<template>
  <div ref="container" class="three-wrap"></div>
</template>


