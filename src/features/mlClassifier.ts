// Dynamic import is used because @huggingface/transformers is ESM-only
// while this project outputs CommonJS. Node.js CJS modules support
// dynamic import() natively.
import fs from 'fs'
import path from 'path'

const NSFW_THRESHOLD = parseFloat(process.env.NSFW_THRESHOLD ?? '0.8')
const CINCINNATI_THRESHOLD = parseFloat(
  process.env.CINCINNATI_THRESHOLD ?? '0.5',
)

type WeightedLabel = { label: string; weight: number }

const LABELS_PATH = path.resolve('./labels.json')

function loadLabels(): WeightedLabel[] {
  return JSON.parse(fs.readFileSync(LABELS_PATH, 'utf-8')) as WeightedLabel[]
}

let weightedLabels: WeightedLabel[] = loadLabels()

console.log('Loaded labels:', weightedLabels.length, 'entries')

fs.watchFile(LABELS_PATH, { interval: 5000 }, () => {
  try {
    weightedLabels = loadLabels()
    console.log('Labels reloaded:', weightedLabels.length, 'entries')
  } catch (err) {
    console.error('Failed to reload labels.json:', err)
  }
})

// A single zero-shot pipeline handles both Cincinnati relevance and NSFW
// detection. michellejieli/NSFW_text_classifier has no ONNX export and
// cannot be used with @huggingface/transformers. Reusing the zero-shot model
// avoids a second download and works reliably.
let zeroShotPipeline:
  | ((
      text: string,
      labels: string[],
      options?: Record<string, unknown>,
    ) => Promise<any>)
  | null = null

export async function initClassifiers(): Promise<void> {
  console.log('Initializing ML classifiers (first run will download models)...')
  const start = Date.now()
  try {
    const { pipeline } = await import('@huggingface/transformers')
    zeroShotPipeline = await pipeline(
      'zero-shot-classification',
      'Xenova/nli-deberta-v3-small',
    )
    console.log(`ML classifiers initialized in ${Date.now() - start}ms`)
  } catch (err) {
    console.error('Failed to initialize ML classifiers:', err)
    // Leave pipelines as null — the callers handle null gracefully
  }
}

/**
 * Returns a relevance score 0–1 indicating how Cincinnati-related the text is.
 * Returns 0 if the classifier is not yet initialized or inference fails.
 */
export async function classifyCincinnatiRelevance(
  text: string,
): Promise<number> {
  if (!zeroShotPipeline) return 0

  try {
    const result = await zeroShotPipeline(
      text,
      weightedLabels.map((l) => l.label),
      { multi_label: true, hypothesis_template: '{}.' },
    )

    const resultLabels = result.labels as string[]
    const resultScores = result.scores as number[]

    const scoreMap = new Map<string, number>()
    resultLabels.forEach((label, i) => scoreMap.set(label, resultScores[i]))

    let weightedSum = 0
    let totalPositiveWeight = 0

    for (const { label, weight } of weightedLabels) {
      const modelScore = scoreMap.get(label) ?? 0
      weightedSum += modelScore * weight
      if (weight > 0) totalPositiveWeight += weight
    }

    const normalized = Math.max(
      0,
      Math.min(1, weightedSum / totalPositiveWeight),
    )

    if (normalized < CINCINNATI_THRESHOLD) return 0

    console.log(
      `Cincinnati score: ${normalized.toFixed(3)} — "${text.slice(0, 60)}"`,
    )

    return normalized
  } catch (err) {
    console.error('Cincinnati classification failed:', err)
    return 0
  }
}

/**
 * Returns true if the text is classified as NSFW above the threshold.
 * Uses the same zero-shot pipeline with explicit content labels.
 * Returns false if the classifier is not yet initialized or inference fails.
 */
export async function classifyNSFW(text: string): Promise<boolean> {
  if (!zeroShotPipeline) {
    console.log(
      'NSFW classifier not ready yet — skipping ML NSFW check (returning false)',
    )
    return false
  }
  try {
    const result = await zeroShotPipeline(text, [
      'explicit sexual content',
      'safe for work',
    ])
    const nsfwIdx = (result.labels as string[]).indexOf(
      'explicit sexual content',
    )
    const score = (result.scores as number[])[nsfwIdx]
    const isNSFW = typeof score === 'number' && score >= NSFW_THRESHOLD
    if (isNSFW) {
      console.log(`NSFW score: ${score.toFixed(3)} for text: ${text}`)
    }
    return isNSFW
  } catch (err) {
    console.error('NSFW classification failed:', err)
    return false
  }
}
