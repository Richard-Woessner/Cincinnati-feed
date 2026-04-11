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

/**
 * Levelled logger. Control verbosity via LOG_LEVEL in .env:
 *   error  — errors only
 *   warn   — errors + warnings
 *   info   — normal operational messages (default)
 *   debug  — per-post / per-actor filter decisions
 *   trace  — very high-volume events (e.g. every deleted post)
 */
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 } as const
type LogLevel = keyof typeof LOG_LEVELS
const _raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as LogLevel
const _threshold: number = LOG_LEVELS[_raw] ?? LOG_LEVELS.info

export const logger = {
  error: (...args: unknown[]) => console.error(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  info: (...args: unknown[]) => {
    if (_threshold >= LOG_LEVELS.info) console.log(...args)
  },
  debug: (...args: unknown[]) => {
    if (_threshold >= LOG_LEVELS.debug) console.log(...args)
  },
  trace: (...args: unknown[]) => {
    if (_threshold >= LOG_LEVELS.trace) console.log(...args)
  },
}
