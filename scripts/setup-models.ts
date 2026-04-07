#!/usr/bin/env ts-node
/**
 * Pre-downloads ML models so they don't need to be fetched on first startup.
 * Models are cached in ./models/ directory and mounted into the Docker container.
 *
 * Usage: npx ts-node scripts/setup-models.ts
 */

import path from 'path'

async function setupModels() {
  const modelDir = path.join(process.cwd(), 'models')
  console.log(`Setting HF_HOME to ${modelDir}`)
  process.env.HF_HOME = modelDir

  console.log('Downloading Xenova/nli-deberta-v3-small model...')
  console.log('(This may take 1-5 minutes on first run)')

  try {
    const { pipeline } = await import('@huggingface/transformers')
    const start = Date.now()

    const classifier = await pipeline(
      'zero-shot-classification',
      'Xenova/nli-deberta-v3-small',
    )

    console.log(`✅ Model downloaded and cached in ${modelDir}`)
    console.log(
      `⏱️  Setup completed in ${((Date.now() - start) / 1000).toFixed(1)}s`,
    )

    // Test the model with a quick inference
    console.log('\nTesting classifier with sample text...')
    const result = await classifier('Cincinnati Ohio Bengals', [
      'about Cincinnati Ohio',
      'not about Cincinnati Ohio',
    ])
    console.log('Classification result:', result)
    console.log(
      `✅ Model is working correctly (Cincinnati score: ${result.scores[0].toFixed(3)})`,
    )
  } catch (err) {
    console.error('❌ Failed to setup models:', err)
    process.exit(1)
  }
}

setupModels()
