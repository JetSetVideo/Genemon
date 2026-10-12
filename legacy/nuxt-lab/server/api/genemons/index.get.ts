import { defineEventHandler } from 'h3'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export default defineEventHandler(async () => {
  const dir = join(process.cwd(), 'data', 'genemons')
  try {
    const files = await readdir(dir)
    const jsonFiles = files.filter(f => f.endsWith('.json'))
    const items = await Promise.all(
      jsonFiles.map(async f => {
        const raw = await readFile(join(dir, f), 'utf-8')
        return JSON.parse(raw)
      })
    )
    return { items }
  } catch (e: any) {
    return { items: [], error: String(e?.message || e) }
  }
})


