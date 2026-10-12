import { defineEventHandler, getRouterParam } from 'h3'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) return { error: 'Missing id' }
  const file = join(process.cwd(), 'data', 'genemons', `${id}.json`)
  try {
    const raw = await readFile(file, 'utf-8')
    return JSON.parse(raw)
  } catch (e: any) {
    return { error: String(e?.message || e) }
  }
})


