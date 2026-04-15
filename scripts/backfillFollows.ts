#!/usr/bin/env ts-node
/**
 * Backfills follows for Cincinnati actors whose bio scores >= FOLLOW_CINCINNATI_THRESHOLD.
 *
 * Iterates every non-blocked actor in the DB, re-scores their stored bio with
 * the ML classifier, and follows them from the publisher account if their score
 * meets the threshold.  Already-followed accounts are skipped gracefully.
 *
 * Usage:
 *   yarn backfill:follows           — follow matching accounts
 *   yarn backfill:follows:dry-run   — list matching accounts without following
 *
 * Dry-run mode can also be enabled with: DRY_RUN=true yarn backfill:follows
 *
 * Environment variables (same .env as the main app):
 *   FEEDGEN_SQLITE_LOCATION    — path to the SQLite DB (default: ./data/db.sqlite)
 *   FEEDGEN_PUBLISHER_DID      — your Bluesky DID (used to log in and as the follow repo)
 *   BLUESKY_PASSWORD           — your Bluesky app password
 *   FOLLOW_CINCINNATI_THRESHOLD — minimum bio score to trigger a follow (default: 0.9)
 *   DRY_RUN                    — set to "true" to list matches without following
 *   HF_HOME                    — HuggingFace model cache dir (default: ./models)
 */

import * as dotenv from 'dotenv'
dotenv.config()

import path from 'path'
import { AtpAgent } from '@atproto/api'
import { createDb, migrateToLatest } from '../src/db'
import {
  initClassifiers,
  classifyCincinnatiRelevance,
} from '../src/features/mlClassifier'

// Point the HF cache at the pre-downloaded models directory by default
process.env.HF_HOME = process.env.HF_HOME ?? path.join(process.cwd(), 'models')

const FOLLOW_CINCINNATI_THRESHOLD = parseFloat(
  process.env.FOLLOW_CINCINNATI_THRESHOLD ?? '0.9',
)

const DB_LOCATION =
  process.env.FEEDGEN_SQLITE_LOCATION ??
  path.join(process.cwd(), 'data', 'db.sqlite')

// Dry-run: list accounts that would be followed without making any API calls.
// Enable via --dry-run CLI flag or DRY_RUN=true env var.
const DRY_RUN =
  process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true'

// Milliseconds to wait between follow API calls to avoid rate limiting
const FOLLOW_DELAY_MS = 300

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  console.log(`Connecting to DB at ${DB_LOCATION}`)
  const db = createDb(DB_LOCATION)
  await migrateToLatest(db)

  const agent = new AtpAgent({ service: 'https://bsky.social' })
  if (DRY_RUN) {
    console.log('DRY RUN — no follows will be created.')
  } else {
    console.log('Logging in to Bluesky...')
    await agent.login({
      identifier: process.env.FEEDGEN_PUBLISHER_DID!,
      password: process.env.BLUESKY_PASSWORD!,
    })
    console.log('Logged in.')
  }

  await initClassifiers()

  const actors = await db
    .selectFrom('actor')
    .select(['did', 'name', 'description'])
    .where('blocked', '=', 0)
    .execute()

  console.log(
    `Evaluating ${actors.length} actor(s) against follow threshold ${FOLLOW_CINCINNATI_THRESHOLD}...`,
  )

  let followed = 0
  let skipped = 0
  let alreadyFollowing = 0
  let failed = 0

  for (const { did, name, description } of actors) {
    const bio = description ?? ''
    const bioScore = await classifyCincinnatiRelevance(bio)

    if (bioScore < FOLLOW_CINCINNATI_THRESHOLD) {
      skipped++
      continue
    }

    if (DRY_RUN) {
      console.log(
        `  [DRY RUN] Would follow ${name || did} — score=${bioScore.toFixed(3)} (did=${did})`,
      )
      followed++
      continue
    }

    console.log(`  → Following ${name || did} (score=${bioScore.toFixed(3)})`)

    try {
      await agent.api.app.bsky.graph.follow.create(
        { repo: process.env.FEEDGEN_PUBLISHER_DID! },
        { subject: did, createdAt: new Date().toISOString() },
      )
      followed++
    } catch (err: any) {
      // AlreadyExists (status 409 or xrpc error) means we already follow them
      const msg: string = err?.message ?? ''
      if (
        msg.includes('AlreadyExists') ||
        msg.includes('already exists') ||
        err?.status === 409
      ) {
        alreadyFollowing++
      } else {
        console.error(`  ✗ Failed to follow ${did}:`, err?.message ?? err)
        failed++
      }
    }

    await sleep(FOLLOW_DELAY_MS)
  }

  if (DRY_RUN) {
    console.log(
      `\n[DRY RUN] Would follow=${followed}, below_threshold=${skipped}`,
    )
  } else {
    console.log(
      `\nDone. followed=${followed}, already_following=${alreadyFollowing}, below_threshold=${skipped}, failed=${failed}`,
    )
  }

  await db.destroy()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
