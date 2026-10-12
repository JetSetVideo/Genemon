import { defineEventHandler, readBody } from 'h3'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const id = body?.id
  const data = body?.data
  if (!id || !data) return { ok: false, error: 'Missing id or data' }
  const file = join(process.cwd(), 'data', 'genemons', `${id}.json`)
  try {
    await writeFile(file, JSON.stringify(data, null, 2), 'utf-8')
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
})


