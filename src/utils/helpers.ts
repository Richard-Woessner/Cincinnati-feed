export function chunkArray<T>(array: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(array.length / size) }, (_, i) =>
    array.slice(i * size, i * size + size),
  )
}

export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

export function sanitizeString(value: unknown): string {
  if (typeof value !== 'string') return ''
  let safe = value.replace(/\r?\n|\n/g, ' ')
  safe = safe.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  return safe
}

export function isCincinnatiUser(bio: string | null): boolean {
  if (!bio || bio == '') return false
  bio = bio.toLowerCase()
  return /\b(cincy|cincinnati|cinci)\b/i.test(bio)
}
