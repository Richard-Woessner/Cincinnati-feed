// Dynamic import is used because @huggingface/transformers is ESM-only
// while this project outputs CommonJS. Node.js CJS modules support
// dynamic import() natively.

const NSFW_THRESHOLD = parseFloat(process.env.NSFW_THRESHOLD ?? '0.8')
const CINCINNATI_THRESHOLD = parseFloat(
  process.env.CINCINNATI_THRESHOLD ?? '0.5',
)

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

const CINCINNATI_LABELS = [
  // Positive signals — be specific
  'this post mentions Cincinnati, Ohio',
  'this post is about a Cincinnati neighborhood like Over-the-Rhine, Hyde Park, Clifton, or Northside',
  'this post mentions Cincinnati sports like the Bengals, Reds, FC Cincinnati, or UC Bearcats',
  'this post mentions Cincinnati landmarks like Skyline Chili, the Banks, Eden Park, or Music Hall',
  'this post discusses local Cincinnati news, events, or politics',
  // Negative signals — be broad
  'this post has nothing to do with Cincinnati Ohio',
  'this post is about software development, programming, or technology',
  'this post is about national or international news unrelated to Cincinnati',
]

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
    const result = await zeroShotPipeline(text, CINCINNATI_LABELS, {
      multi_label: true,
      hypothesis_template: 'This text is {}.',
    })

    const labels = result.labels as string[]
    const scores = result.scores as number[]

    // Sum all positive label scores, penalise noise labels
    const noiseLabels = [
      'this post has nothing to do with Cincinnati Ohio',
      'this post is about software development, programming, or technology',
      'this post is about national or international news unrelated to Cincinnati',
    ]
    let positiveScore = 0
    let negativeScore = 0

    labels.forEach((label, i) => {
      if (noiseLabels.includes(label)) {
        negativeScore = Math.max(negativeScore, scores[i])
      } else {
        positiveScore = Math.max(positiveScore, scores[i])
      }
    })

    if (positiveScore < CINCINNATI_THRESHOLD) return 0
    const finalScore = Math.max(0, positiveScore - negativeScore * 0.5)

    console.log(
      `Cincinnati relevance: ${finalScore.toFixed(3)} (pos: ${positiveScore.toFixed(3)}, neg: ${negativeScore.toFixed(3)}) — "${text.slice(0, 60)}"`,
    )

    return finalScore
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
