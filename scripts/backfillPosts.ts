#!/usr/bin/env ts-node
/**
 * Backfills posts from known Cincinnati actors into the DB using the
 * same ML pipeline as the firehose subscription.
 *
 * For each actor in the DB, fetches their recent posts (up to BACKFILL_LIMIT
 * per actor) via app.bsky.feed.getAuthorFeed, then applies:
 *   1. Keyword pre-filter
 *   2. ML NSFW check
 *   3. ML Cincinnati relevance check (threshold: CINCINNATI_THRESHOLD)
 *   4. Upsert into the post table (skips duplicates)
 *
 * Usage:
 *   npx ts-node scripts/backfillPosts.ts
 *
 * Environment variables (same .env as the main app):
 *   FEEDGEN_SQLITE_LOCATION  — path to the SQLite DB (default: ./data/db.sqlite)
 *   FEEDGEN_PUBLISHER_DID    — your Bluesky DID (used to log in)
 *   BLUESKY_PASSWORD         — your Bluesky app password
 *   CINCINNATI_THRESHOLD     — ML score cutoff (default: 0.4)
 *   BACKFILL_LIMIT           — posts to fetch per actor (default: 100)
 *   HF_HOME                  — HuggingFace model cache dir (default: ./models)
 */

import * as dotenv from 'dotenv'
dotenv.config()

import path from 'path'
import { BskyAgent } from '@atproto/api'
import { createDb, migrateToLatest } from '../src/db'
import { hasCincinnatiKeywords, sanitizeString } from '../src/utils/helpers'
import {
  initClassifiers,
  classifyCincinnatiRelevance,
  classifyNSFW,
} from '../src/features/mlClassifier'
import { validatePostData } from '../src/features/validatePostData'

// Point the HF cache at the pre-downloaded models directory by default
process.env.HF_HOME = process.env.HF_HOME ?? path.join(process.cwd(), 'models')

const CINCINNATI_THRESHOLD = parseFloat(
  process.env.CINCINNATI_THRESHOLD ?? '0.4',
)
const BACKFILL_LIMIT = parseInt(process.env.BACKFILL_LIMIT ?? '100', 10)
const DB_LOCATION =
  process.env.FEEDGEN_SQLITE_LOCATION ??
  path.join(process.cwd(), 'data', 'db.sqlite')

async function main() {
  console.log(`Connecting to DB at ${DB_LOCATION}`)
  const db = createDb(DB_LOCATION)
  await migrateToLatest(db)

  const agent = new BskyAgent({ service: 'https://bsky.social' })
  console.log('Logging in to Bluesky...')
  await agent.login({
    identifier: process.env.FEEDGEN_PUBLISHER_DID!,
    password: process.env.BLUESKY_PASSWORD!,
  })
  console.log('Logged in.')

  await initClassifiers()

  // Load all known (non-blocked) Cincinnati actors (bio included for ML context)
  const actors = await db
    .selectFrom('actor')
    .select(['did', 'description'])
    .where('blocked', '=', 0)
    .execute()

  console.log(
    `Starting backfill for ${actors.length} actors (${BACKFILL_LIMIT} posts each)...`,
  )

  let inserted = 0
  let skipped = 0

  for (const { did, description } of actors) {
    console.log(`  Fetching posts for ${did}...`)
    let cursor: string | undefined
    let fetched = 0

    while (fetched < BACKFILL_LIMIT) {
      const limit = Math.min(100, BACKFILL_LIMIT - fetched)
      let response: Awaited<ReturnType<typeof agent.getAuthorFeed>>

      try {
        response = await agent.getAuthorFeed({
          actor: did,
          limit,
          cursor,
          filter: 'posts_no_replies',
        })
      } catch (err) {
        console.error(`  Failed to fetch feed for ${did}:`, err)
        break
      }

      const { feed, cursor: nextCursor } = response.data

      for (const item of feed) {
        const post = item.post
        const postText: string = (post.record as any)?.text ?? ''

        // Skip reposts / embeds that aren't original text posts
        if (!postText) {
          skipped++
          continue
        }

        // Keyword pre-filter — for known actors we skip this gate
        // (same logic as the firehose: known Cincinnati users bypass it)

        // Combine post text with the author's bio — same as the firehose pipeline
        const mlText = [postText, description].filter(Boolean).join(' ')

        // ML NSFW check
        const mlNSFW = await classifyNSFW(mlText)
        if (mlNSFW) {
          skipped++
          continue
        }

        // ML Cincinnati relevance
        const mlScore = await classifyCincinnatiRelevance(mlText)
        if (mlScore < CINCINNATI_THRESHOLD) {
          skipped++
          continue
        }

        const indexedAt =
          (post.record as any)?.createdAt ?? new Date().toISOString()

        const validPost = await validatePostData({
          uri: post.uri,
          cid: post.cid,
          indexedAt,
          author: post.author.did,
          text: postText,
          mlScore,
        })

        if (!validPost) {
          skipped++
          continue
        }

        await db
          .insertInto('post')
          .values(validPost)
          .onConflict((oc) => oc.doNothing())
          .execute()

        inserted++
      }

      fetched += feed.length

      if (!nextCursor || feed.length === 0) break
      cursor = nextCursor
    }
  }

  console.log(
    `\nBackfill complete: ${inserted} posts inserted, ${skipped} skipped.`,
  )
  process.exit(0)
}

main().catch((err) => {
  console.error('Backfill failed:', err)
  process.exit(1)
})
