<script setup lang="ts">
import * as THREE from 'three'

const container = ref<HTMLDivElement | null>(null)
let renderer: THREE.WebGLRenderer
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let animationId = 0

function init() {
  if (!container.value) return
  const width = container.value.clientWidth
  const height = container.value.clientHeight
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0b0f14)
  camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100)
  camera.position.set(3, 2, 3)
  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(width, height)
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
  container.value.appendChild(renderer.domElement)

  const light = new THREE.DirectionalLight(0xffffff, 1)
  light.position.set(3, 5, 2)
  scene.add(new THREE.AmbientLight(0x404040))
  scene.add(light)

  const grid = new THREE.GridHelper(10, 10, 0x223344, 0x1a2033)
  ;(grid.material as THREE.Material).transparent = true
  scene.add(grid)

  const geo = new THREE.BoxGeometry(1, 1, 1)
  const mat = new THREE.MeshStandardMaterial({ color: 0x5ad7ff })
  const cube = new THREE.Mesh(geo, mat)
  scene.add(cube)

  let t = 0
  const tick = () => {
    t += 0.01
    cube.rotation.y += 0.01
    cube.position.y = Math.sin(t) * 0.1 + 0.5
    renderer.render(scene, camera)
    animationId = requestAnimationFrame(tick)
  }
  tick()

  const onResize = () => {
    if (!container.value) return
    const w = container.value.clientWidth
    const h = container.value.clientHeight
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
  }
  window.addEventListener('resize', onResize)
}

onMounted(init)
onBeforeUnmount(() => { cancelAnimationFrame(animationId); renderer?.dispose?.(); })
</script>

<template>
  <div ref="container" class="three-wrap"></div>
</template>


