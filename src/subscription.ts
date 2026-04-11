import { AppBskyActorDefs, AtpAgent, ComAtprotoLabelDefs } from '@atproto/api'
import { FirehoseSubscriptionBase, JetstreamEvent } from './util/subscription'
import * as fs from 'fs/promises'
import { Database } from './db'
import { Actor, DatabaseSchema } from './db/schema'
import path from 'path'
import { FollowerMap, ValidPostData } from './types'
import {
  chunkArray,
  isCincinnatiUser,
  sanitizeString,
  hasCincinnatiKeywords,
} from './utils/helpers'
import { handleCincinnatiAuthor } from './features/users'
import { validatePostData } from './features/validatePostData'
import { cleanupNonCincinnatiPosts } from './features/cleanNonCincinnatiPosts'
import { isNSFW } from './features/isNSFW'
import {
  initClassifiers,
  classifyCincinnatiRelevance,
  classifyNSFW,
} from './features/mlClassifier'

/**
 * FirehoseSubscription consumes the Bluesky Jetstream (a real-time JSON stream
 * of AT Protocol repo events filtered to app.bsky.feed.post) and filters it
 * down to Cincinnati-related posts.
 *
 * Post inclusion pipeline (per incoming post):
 *   1. Keyword pre-filter  — reject immediately if no Cincinnati keyword in text
 *                            AND author is unknown (cheap, no network/ML cost)
 *   2. Block check         — skip posts from users on the blocked list
 *   3. Label NSFW check    — skip posts that self-label as NSFW/explicit
 *   4. ML NSFW check       — skip posts where the ML classifier detects NSFW text
 *   5. ML Cincinnati check — for unknown authors, require mlScore >= threshold
 *   6. Insert              — write the post and its mlScore to the database
 *
 * Startup sequence:
 *   1. Log into Bluesky as the feed publisher (needed to call the API)
 *   2. Load blocked-users.txt and mark those actors in the DB
 *   3. Optionally run SearchForCincinnatiUsers (controlled by SEARCH_LOOP_ATTEMPTS)
 *   4. Load all known Cincinnati actors from the DB into memory (cincinnatiUsers)
 *   5. Remove any posts in the DB whose author is no longer a known Cincinnati user
 *   6. Warm up the ML classifier models (downloads on first run ~150 MB)
 */
export class FirehoseSubscription extends FirehoseSubscriptionBase {
  private agent = new AtpAgent({ service: 'https://bsky.social' })
  private fileHandle: fs.FileHandle | null = null
  // DIDs from blocked-users.txt — these authors' posts are always skipped
  private blockedUsers: string[] = []
  // DIDs muted by the feed publisher account — their posts are skipped and purged
  private mutedUsers = new Set<string>()
  // Social graph cache built during SearchForCincinnatiUsers
  private followersMap: FollowerMap[] = []
  // In-memory copy of the actor table used for O(n) author lookups per event
  private cincinnatiUsers: Actor[] = []

  // Resolves when the full startup sequence (agent login, actor loading,
  // ML model warm-up) is complete. Await this before accepting HTTP traffic
  // so the feed skeleton never serves requests with uninitialised classifiers.
  public ready: Promise<void>

  constructor(db: Database, service: string) {
    super(db, service)
    console.log('Initializing FirehoseSubscription...')
    // Assign the startup chain to this.ready so callers can await it.
    // Agent login is async, so the rest of startup runs in a chained promise.
    this.ready = this.initializeAgent().then(async () => {
      console.log('Agent initialized.')
      await this.getBlockedUsers()
      await this.loadMutes()
      setInterval(() => this.loadMutes(), 10 * 60 * 1000)

      console.log(process.env.SEARCH_LOOP_ATTEMPTS)

      // SEARCH_LOOP_ATTEMPTS controls how many parallel discovery passes to run.
      // Each pass seeds actors from cincinnati-users.txt, fetches their social
      // graph, and inserts any new Cincinnati-bio users found.
      // Set to 0 (default) to skip discovery and only use existing DB actors.
      const searchLoopAttempts = parseInt(
        process.env.SEARCH_LOOP_ATTEMPTS ?? '0',
      )

      if (searchLoopAttempts !== 0) {
        await Promise.all(
          Array.from({ length: searchLoopAttempts }).map(() =>
            this.SearchForCincinnatiUsers(),
          ),
        )
      }

      // Populate the in-memory actor list used for fast per-event lookups
      await this.getActorsDIDs()
      // Remove stale posts whose authors are no longer recognised as Cincinnati users
      await cleanupNonCincinnatiPosts(db)
      // Download and warm up the ML zero-shot classifier (Xenova/nli-deberta-v3-small).
      // Used for both Cincinnati relevance and NSFW detection.
      // First run downloads ~85 MB; subsequent runs use the local HF cache.
      await initClassifiers()
      console.log(
        'Startup complete — ML classifiers ready, accepting feed requests.',
      )
    })
  }

  // Loads all rows from the actor table into the in-memory cincinnatiUsers array.
  // This avoids a DB query on every incoming firehose event — author lookups
  // are done against this array instead.
  private async getActorsDIDs(): Promise<void> {
    const existing = await this.db.selectFrom('actor').selectAll().execute()

    this.cincinnatiUsers = existing.map((actor) => actor)

    return
  }

  // Reads blocked-users.txt (one DID per line) and:
  //   - Pushes each DID into the in-memory blockedUsers array for fast checks
  //   - Marks the corresponding actor rows in the DB as blocked=1
  // This file is the manual moderation list — add a DID to immediately
  // suppress all future posts from that user.
  private async getBlockedUsers() {
    console.log('Getting blocked users...')

    try {
      const filePath = path.join(process.cwd(), '/blocked-users.txt')
      console.log(`Reading blocked users from: ${filePath}`)
      const fileContent = await fs.readFile(filePath, 'utf-8')
      const actors = fileContent.trim().split('\n').filter(Boolean)

      console.log(`Blocked users found: ${actors.length}`)
      this.blockedUsers.push(...actors)

      if (actors.length > 0) {
        const { numDeletedRows } = await this.db
          .deleteFrom('post')
          .where('author', 'in', actors)
          .executeTakeFirst()
        console.log(
          `Removed ${numDeletedRows} post(s) from blocked users in blocked-users.txt.`,
        )
      }

      await Promise.all(
        actors.map(async (actor) => {
          console.log(`Blocking actor: ${actor}`)
          await this.db
            .updateTable('actor')
            .set({ blocked: 1 })
            .where('did', '=', actor)
            .execute()
        }),
      )

      console.log('Blocked users successfully loaded.')
    } catch (err) {
      console.error('Failed to get blocked users:', err)
    }
  }

  // Fetches all accounts muted by the feed publisher via app.bsky.graph.getMutes,
  // deletes any of their existing posts from the DB, and refreshes the in-memory
  // mutedUsers set. Called at startup and every 10 minutes.
  private async loadMutes() {
    console.log('Loading muted accounts...')
    try {
      const freshMutes = new Set<string>()
      let cursor: string | undefined

      do {
        const res = await this.agent.api.app.bsky.graph.getMutes({
          limit: 100,
          cursor,
        })
        for (const actor of res.data.mutes) {
          freshMutes.add(actor.did)
        }
        cursor = res.data.cursor
      } while (cursor)

      this.mutedUsers = freshMutes
      console.log(`Loaded ${this.mutedUsers.size} muted account(s).`)

      if (this.mutedUsers.size > 0) {
        const mutedDids = Array.from(this.mutedUsers)
        const { numDeletedRows } = await this.db
          .deleteFrom('post')
          .where('author', 'in', mutedDids)
          .executeTakeFirst()
        if (numDeletedRows > 0) {
          console.log(`Removed ${numDeletedRows} post(s) from muted accounts.`)
        }
      }
    } catch (err) {
      console.error('Failed to load mutes:', err)
    }
  }

  // Returns the actor record for a given DID if they are a known Cincinnati user,
  // or undefined if the author is not in our list. Unknown authors can still pass
  // through if their post scores above CINCINNATI_THRESHOLD via ML.
  private getAuthor(did: string) {
    return this.cincinnatiUsers.find((actor) => actor.did === did)
  }

  // Fetches up to 100 followers for every known Cincinnati
  // actor and stores them in followersMap. These are then
  // used by SearchForCincinnatiUsers to discover new Cincinnati users via
  // social-graph expansion ("people who follow Cincinnati users may also be
  // Cincinnati users").
  private async populateFollowers() {
    console.log('Populating followers...')
    try {
      const actors = await this.db.selectFrom('actor').select(['did']).execute()
      console.log(`Fetched ${actors.length} actors from the database.`)

      await Promise.all(
        actors.map(async ({ did }) => {
          console.log(`Fetching followers for DID: ${did}`)
          const followers = await this.fetchFollowers(did)
          console.log(
            `Fetched ${followers.followers.length} followers for DID: ${did}`,
          )

          this.followersMap.push(followers)
        }),
      )

      console.log('Successfully populated followers and following lists.')
    } catch (err) {
      console.error('Failed to populate followers:', err)
    }
  }

  private async fetchFollowers(did: string): Promise<FollowerMap> {
    console.log(`Fetching followers for DID: ${did}`)
    try {
      const { data } = await this.agent.api.app.bsky.graph.getFollowers({
        actor: did,
        limit: 100, // Adjust as needed
      })

      console.log(`Fetched ${data.followers.length} followers for DID: ${did}`)
      return {
        userDid: did,
        followers: data.followers,
      }
    } catch (err) {
      console.error(`Failed to fetch followers for ${did}:`, err)
      return { userDid: did, followers: [] }
    }
  }

  private async fetchProfiles(dids: string[]) {
    console.log(`Fetching profiles for ${dids.length} DIDs.`)
    const chunks = chunkArray(dids, 25)
    const profiles: AppBskyActorDefs.ProfileView[] = []

    for (const chunk of chunks) {
      try {
        const response = await this.agent.getProfiles({ actors: chunk })
        profiles.push(...response.data.profiles)
      } catch (err) {
        console.error('Failed to fetch profiles chunk:', err)
      }
    }

    return profiles
  }

  // Discovers new Cincinnati users via social-graph expansion:
  //   1. Seed known Cincinnati DIDs from cincinnati-users.txt
  //   2. Fetch their followers and following lists (up to 100 each)
  //   3. Batch-fetch profiles (25 at a time to stay within API limits)
  //   4. For each profile, check if the bio contains Cincinnati keywords
  //   5. If so, insert as a new actor (skipping duplicates)
  // The number of times this runs is controlled by SEARCH_LOOP_ATTEMPTS;
  // additional iterations expand the graph further (followers-of-followers, etc.).
  private async SearchForCincinnatiUsers() {
    console.log('Searching for Cincinnati users...')

    await this.seedActorsFromFile()
    await this.populateFollowers()

    for (const followers of this.followersMap) {
      const dids = followers.followers.map((f) => f.did)
      console.log(`Processing ${dids.length} DIDs from followers.`)
      const profiles = await this.fetchProfiles(dids)

      for (const profile of profiles) {
        if (!profile.description) {
          continue
        }

        const exists = await this.db
          .selectFrom('actor')
          .selectAll()
          .where('did', '=', profile.did)
          .executeTakeFirst()

        if (exists) {
          console.log(`Actor ${profile.did} already exists. Skipping insert.`)
          continue
        }

        if (isCincinnatiUser(profile.description)) {
          console.log('Inserting actor:', {
            did: profile.did,
            description: sanitizeString(profile.description),
            blocked: 0,
          })
          await this.db
            .insertInto('actor')
            .values({
              did: profile.did,
              name: sanitizeString(profile.displayName ?? '') ?? '',
              description: sanitizeString(profile.description),
              blocked: 0,
            })
            .onConflict((oc) => oc.doNothing())
            .execute()
        }
      }
    }
    console.log('Completed search for Cincinnati users.')
  }

  // Reads cincinnati-users.json and inserts each entry into the actor table.
  // These are the manually curated seed accounts that bootstrap the
  // social-graph discovery in SearchForCincinnatiUsers.
  private async seedActorsFromFile() {
    console.log('Seeding actors from file...')
    try {
      const filePath = path.join(process.cwd(), 'cincinnati-users.json')
      console.log(`Reading actors from: ${filePath}`)
      const fileContent = await fs.readFile(filePath, 'utf-8')
      const actors: { did: string; name: string; bio: string }[] =
        JSON.parse(fileContent)
      console.log(`Found ${actors.length} actors to seed.`)

      await Promise.all(
        actors.map(async ({ did, name, bio }) => {
          console.log(`Seeding actor DID: ${did}`)
          try {
            await this.db
              .insertInto('actor')
              .values({
                did,
                name: sanitizeString(name) ?? '',
                description: sanitizeString(bio) ?? '',
                blocked: 0,
              })
              .onConflict((oc) => oc.doNothing())
              .execute()
            console.log(`Successfully seeded actor ${did}.`)
          } catch (err) {
            console.error(`Failed to seed actor ${did}:`, err)
          }
        }),
      )
      console.log('Successfully seeded actors from file.')
    } catch (err) {
      console.error('Failed to seed actors:', err)
    }
  }

  async initializeAgent() {
    console.log('Initializing agent login...')
    try {
      await this.agent.login({
        identifier: process.env.FEEDGEN_PUBLISHER_DID!,
        password: process.env.BLUESKY_PASSWORD!,
      })
      console.log('Agent successfully logged in.')
    } catch (err) {
      console.error('Failed to initialize agent:', err)
    }
  }

  // Called for every Jetstream event. Non-commit events (identity updates, account
  // changes, etc.) are ignored — we only care about post creates and deletes.
  async handleEvent(evt: JetstreamEvent) {
    if (evt.kind !== 'commit' || !evt.commit) {
      return
    }

    const { operation, collection, rkey, cid, record } = evt.commit

    // Only process app.bsky.feed.post events
    if (collection !== 'app.bsky.feed.post') {
      return
    }

    const postUri = `at://${evt.did}/app.bsky.feed.post/${rkey}`

    // Mirror deletions — if a user deletes a post on Bluesky, remove it from
    // the feed database so it stops appearing in the feed skeleton.
    if (operation === 'delete') {
      try {
        this.db.deleteFrom('post').where('uri', 'in', [postUri]).execute()
        console.log('Successfully deleted post:', postUri)
      } catch (err) {
        console.error('Failed to delete post:', err)
      }
      return
    }

    if (operation !== 'create' || !record || !cid) {
      return
    }

    const postsToCreate: DatabaseSchema['post'][] = []

    // Minimum ML confidence score (0–1) for an unknown author's post to be
    // included in the feed. Known Cincinnati users bypass this threshold.
    // Override via the CINCINNATI_THRESHOLD environment variable.
    const CINCINNATI_THRESHOLD = parseFloat(
      process.env.CINCINNATI_THRESHOLD ?? '0.4',
    )

    const author = evt.did
    const actor = this.getAuthor(author)
    const postText = record.text ?? ''

    // Fast reject: skip posts with no connection to Cincinnati at all
    if (!actor && !hasCincinnatiKeywords(postText)) {
      return
    }

    // Fast reject: skip non-English posts
    const langs: string[] | undefined = record.langs
    if (langs && langs.length > 0 && !langs.some((l) => l.startsWith('en'))) {
      return
    }

    // Skip blocked authors
    if (this.blockedUsers.includes(author) || (actor && actor.blocked)) {
      console.log('Author is blocked, skipping post')
      return
    }

    // Skip muted authors
    if (this.mutedUsers.has(author)) {
      return
    }

    // Fast label-based NSFW check (no ML cost)
    if (isNSFW(record.labels as any)) {
      return
    }

    // Combine post text with the author's bio so the classifier has more
    // signal — reduces false positives for short posts that lack keywords.
    const mlText = [postText, actor?.description].filter(Boolean).join(' ')

    // Run ML NSFW + Cincinnati relevance in parallel
    const [mlNSFW, mlScore] = await Promise.all([
      classifyNSFW(mlText),
      classifyCincinnatiRelevance(mlText),
    ])

    if (mlNSFW) {
      console.log(
        `[${postUri}] ML flagged as NSFW — skipping (mlScore=${mlScore.toFixed(3)})`,
      )
      return
    }

    // Unknown-author posts must clear the Cincinnati relevance threshold
    if (!actor && mlScore < CINCINNATI_THRESHOLD) {
      console.log(
        `[${postUri}] Below Cincinnati threshold — skipping (mlScore=${mlScore.toFixed(3)}, threshold=${CINCINNATI_THRESHOLD})`,
      )
      return
    }

    const validPost = await validatePostData({
      uri: postUri,
      cid,
      indexedAt: new Date().toISOString(),
      author,
      text: postText,
      mlScore,
    })

    if (!actor && mlScore >= CINCINNATI_THRESHOLD) {
      await handleCincinnatiAuthor(
        this.db,
        this.agent,
        this.cincinnatiUsers,
        author,
        this.blockedUsers,
      )
    }

    if (validPost) {
      console.log(
        `Valid post ready for insertion: ${validPost.uri} (mlScore=${mlScore.toFixed(3)})`,
      )
      postsToCreate.push(validPost)
    } else {
      console.error('Post validation failed for uri:', postUri)
    }

    if (postsToCreate.length > 0) {
      try {
        this.db
          .insertInto('post')
          .values(postsToCreate)
          .onConflict((oc) => oc.doNothing())
          .execute()
        console.log(
          `Successfully inserted ${postsToCreate.length} post(s): ${postsToCreate.map((p) => `${p.uri} (mlScore=${p.mlScore !== null ? p.mlScore.toFixed(3) : 'n/a'})`).join(', ')}`,
        )
      } catch (err) {
        console.error('Failed to create posts:', err)
      }
    }

    // Persist the Jetstream cursor (time_us) so the feed can resume from this
    // position after a restart instead of replaying the entire event history.
    this.db
      .updateTable('sub_state')
      .set({ cursor: evt.time_us })
      .where('service', '=', this.service)
      .execute()
  }

  // Reads the last known cursor (Jetstream time_us) from sub_state.
  // A cursor of 0 means "start from live head" — Jetstream will omit the
  // cursor param in that case. Returns undefined if the row doesn't exist yet.
  async getCursor(): Promise<{ cursor?: number }> {
    const res = await this.db
      .selectFrom('sub_state')
      .selectAll()
      .where('service', '=', this.service)
      .executeTakeFirst()

    if (!res) {
      console.warn('⚠️ sub_state row not found — will start from live head.')
      return {}
    }

    console.log('✅ Loaded cursor (time_us):', res.cursor)
    return { cursor: res.cursor }
  }
}
