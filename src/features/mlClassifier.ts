// Dynamic import is used because @huggingface/transformers is ESM-only
// while this project outputs CommonJS. Node.js CJS modules support
// dynamic import() natively.

const NSFW_THRESHOLD = parseFloat(process.env.NSFW_THRESHOLD ?? '0.8')

// A single zero-shot pipeline handles both Cincinnati relevance and NSFW
// detection. michellejieli/NSFW_text_classifier has no ONNX export and
// cannot be used with @huggingface/transformers. Reusing the zero-shot model
// avoids a second download and works reliably.
let zeroShotPipeline:
  | ((text: string, labels: string[]) => Promise<any>)
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
  if (!zeroShotPipeline) {
    console.log(
      'Cincinnati classifier not ready yet — skipping ML score (returning 0)',
    )
    return 0
  }
  try {
    const result = await zeroShotPipeline(text, [
      'about Cincinnati Ohio',
      'not about Cincinnati Ohio',
    ])
    const cincyIdx = (result.labels as string[]).indexOf(
      'about Cincinnati Ohio',
    )
    const score = (result.scores as number[])[cincyIdx]

    console.log(
      `Cincinnati relevance score: ${score.toFixed(3)} for text: ${text}`,
    )

    return typeof score === 'number' ? score : 0
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
