import { defineNuxtConfig } from 'nuxt/config'

export default defineNuxtConfig({
  compatibilityDate: '2025-12-30',
  css: ['~/master.css', '~/assets/css/base.css'],
  nitro: {
    preset: 'deno-server',
    compatibilityDate: '2025-12-30'
  },
  modules: [],
  app: {
    head: {
      title: 'Genemon Lab',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Prototype lab to generate, evolve, and visualize Genemons in 3D' }
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }
      ]
    }
  },
  vite: {
    optimizeDeps: { include: ['three'] },
    server: {
      watch: {
        // Ignore .nuxt directory to prevent file watcher issues in Deno
        ignored: ['**/.nuxt/**']
      }
    }
  },
  experimental: {
    typedPages: true
  },
  typescript: {
    strict: true
  }
})


