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
  return (
    bio.includes('cincinnati') || bio.includes('cincy') || bio.includes('cinci')
  )
}

const CINCINNATI_KEYWORDS = [
  'cincinnati',
  'cincy',
  'cinci',
  'bengals',
  'fc cincinnati',
  'cincinnati reds',
  'xavier musketeers',
  'uc bearcats',
  'bearcats',
  '513',
  'clifton',
  'hyde park',
  'over-the-rhine',
  'otr ohio',
  'covington ky',
  'newport ky',
  'northern kentucky',
  'nky',
  'paul brown stadium',
  'paycor stadium',
  'great american ball park',
  'carew tower',
  'rookwood',
  'skyline chili',
  'goetta',
  'mt. adams',
  'mt adams',
  'anderson township',
  'blue ash',
  'mason ohio',
  'westwood ohio',
  'price hill',
  'norwood ohio',
  'finneytown',
  'kenwood ohio',
  'mariemont',
  'montgomery ohio',
]

export function hasCincinnatiKeywords(text: string): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  return CINCINNATI_KEYWORDS.some((kw) => lower.includes(kw))
}
