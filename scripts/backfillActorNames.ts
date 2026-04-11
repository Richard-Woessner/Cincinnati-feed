#!/usr/bin/env ts-node
/**
 * Backfills display names into the actor table by fetching each actor's
 * Bluesky profile and updating the `name` column.
 *
 * Only actors with a missing or empty name are touched.
 *
 * Usage:
 *   npx ts-node scripts/backfillActorNames.ts
 *
 * Environment variables (same .env as the main app):
 *   FEEDGEN_SQLITE_LOCATION  — path to the SQLite DB (default: ./data/db.sqlite)
 *   FEEDGEN_PUBLISHER_DID    — your Bluesky DID (used to log in)
 *   BLUESKY_PASSWORD         — your Bluesky app password
 */

import * as dotenv from 'dotenv'
dotenv.config()

import path from 'path'
import { AtpAgent } from '@atproto/api'
import { createDb, migrateToLatest } from '../src/db'
import { sanitizeString } from '../src/utils/helpers'

const DB_LOCATION =
  process.env.FEEDGEN_SQLITE_LOCATION ??
  path.join(process.cwd(), 'data', 'db.sqlite')

// Number of profiles to request in each batch (Bluesky allows up to 25)
const BATCH_SIZE = 25

// Milliseconds to wait between batches to avoid rate limiting
const BATCH_DELAY_MS = 500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  console.log(`Connecting to DB at ${DB_LOCATION}`)
  const db = createDb(DB_LOCATION)
  await migrateToLatest(db)

  const agent = new AtpAgent({ service: 'https://bsky.social' })
  console.log('Logging in to Bluesky...')
  await agent.login({
    identifier: process.env.FEEDGEN_PUBLISHER_DID!,
    password: process.env.BLUESKY_PASSWORD!,
  })
  console.log('Logged in.')

  const actors = await db
    .selectFrom('actor')
    .select('did')
    .where((eb) => eb.or([eb('name', 'is', null), eb('name', '=', '')]))
    .execute()

  if (actors.length === 0) {
    console.log('All actors already have names. Nothing to do.')
    await db.destroy()
    return
  }

  console.log(`Found ${actors.length} actor(s) with missing names.`)

  const dids = actors.map((a) => a.did)
  let updated = 0
  let failed = 0

  for (let i = 0; i < dids.length; i += BATCH_SIZE) {
    const batch = dids.slice(i, i + BATCH_SIZE)
    console.log(
      `  Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(dids.length / BATCH_SIZE)} — fetching ${batch.length} profile(s)...`,
    )

    let profiles: Awaited<ReturnType<typeof agent.getProfiles>>

    try {
      profiles = await agent.getProfiles({ actors: batch })
    } catch (err) {
      console.error(`  Failed to fetch batch starting at index ${i}:`, err)
      failed += batch.length
      continue
    }

    for (const profile of profiles.data.profiles) {
      const name = sanitizeString(profile.displayName ?? '') ?? ''
      try {
        await db
          .updateTable('actor')
          .set({ name })
          .where('did', '=', profile.did)
          .execute()
        console.log(`  Updated: ${profile.did} → "${name}"`)
        updated++
      } catch (err) {
        console.error(`  Failed to update ${profile.did}:`, err)
        failed++
      }
    }

    if (i + BATCH_SIZE < dids.length) {
      await sleep(BATCH_DELAY_MS)
    }
  }

  console.log(`\nDone. Updated: ${updated}, Failed: ${failed}`)
  await db.destroy()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
