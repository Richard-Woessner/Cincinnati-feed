import {
  OutputSchema as RepoEvent,
  isCommit,
} from './lexicon/types/com/atproto/sync/subscribeRepos'
import {
  AppBskyActorDefs,
  AppBskyActorGetProfiles,
  BskyAgent,
  ComAtprotoLabelDefs,
} from '@atproto/api'
import { FirehoseSubscriptionBase, getOpsByType } from './util/subscription'
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
 * FirehoseSubscription consumes the Bluesky firehose (a real-time stream of all
 * AT Protocol repo events) and filters it down to Cincinnati-related posts.
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
  private agent = new BskyAgent({ service: 'https://bsky.social' })
  private fileHandle: fs.FileHandle | null = null
  // DIDs from blocked-users.txt — these authors' posts are always skipped
  private blockedUsers: string[] = []
  // Social graph caches built during SearchForCincinnatiUsers
  private followersMap: FollowerMap[] = []
  private followingMap: FollowerMap[] = []
  // In-memory copy of the actor table used for O(n) author lookups per event
  private cincinnatiUsers: Actor[] = []

  // Resolves when the full startup sequence (agent login, actor loading,
  // ML model warm-up) is complete. Await this before accepting HTTP traffic
  // so the feed skeleton never serves requests with uninitialised classifiers.
  public ready: Promise<void>

  constructor(db: Database, service: string) {
    super(db, service)
    console.log('Initializing FirehoseSubscription...')
    // Restore the firehose cursor so we resume from where we left off
    this.getCursor()
    // Assign the startup chain to this.ready so callers can await it.
    // Agent login is async, so the rest of startup runs in a chained promise.
    this.ready = this.initializeAgent().then(async () => {
      console.log('Agent initialized.')
      await this.getBlockedUsers()

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
      const actors = fileContent.trim().split('\n')

      console.log(`Blocked users found: ${actors.length}`)
      this.blockedUsers.push(...actors)

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

  // Returns the actor record for a given DID if they are a known Cincinnati user,
  // or undefined if the author is not in our list. Unknown authors can still pass
  // through if their post scores above CINCINNATI_THRESHOLD via ML.
  private getAuthor(did: string) {
    return this.cincinnatiUsers.find((actor) => actor.did === did)
  }

  // Fetches up to 100 followers and 100 following for every known Cincinnati
  // actor and stores them in followersMap / followingMap. These maps are then
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
          console.log(`Fetching followers and following for DID: ${did}`)
          const [followers, following] = await Promise.all([
            this.fetchFollowers(did),
            this.fetchFollowing(did),
          ])
          console.log(
            `Fetched ${followers.followers.length} followers and ${following.followers.length} following for DID: ${did}`,
          )

          this.followersMap.push(followers)
          this.followingMap.push(following)
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

  private async fetchFollowing(did: string): Promise<FollowerMap> {
    try {
      const { data } = await this.agent.api.app.bsky.graph.getFollows({
        actor: did,
        limit: 100, // Adjust as needed
      })

      console.log(`Fetched ${data.follows.length} following for DID: ${did}`)
      return {
        userDid: did,
        followers: data.follows,
      }
    } catch (err) {
      console.error(`Failed to fetch following for ${did}:`, err)
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

  // Reads cincinnati-users.txt (one DID per line) and inserts each into the
  // actor table. These are the manually curated seed accounts that bootstrap
  // the social-graph discovery in SearchForCincinnatiUsers.
  private async seedActorsFromFile() {
    console.log('Seeding actors from file...')
    try {
      const filePath = path.join(process.cwd(), 'cincinnati-users.txt')
      console.log(`Reading actors from: ${filePath}`)
      const fileContent = await fs.readFile(filePath, 'utf-8')
      const actors = fileContent.trim().split('\n')
      console.log(`Found ${actors.length} actors to seed.`)

      await Promise.all(
        actors.map(async (did) => {
          console.log(`Seeding actor DID: ${did}`)
          try {
            const profile = await this.agent.getProfile({ actor: did })
            await this.db
              .insertInto('actor')
              .values({
                did: did,
                description: sanitizeString(profile.data.description || ''),
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

  // Called for every event on the Bluesky firehose. Non-commit events (likes,
  // follows, profile updates, etc.) are ignored — we only care about post
  // creates and deletes.
  async handleEvent(evt: RepoEvent) {
    if (!isCommit(evt)) {
      console.log('Event is not a commit, skipping...')
      return
    }

    const ops = await getOpsByType(evt)

    // Collect URIs for posts that were deleted so we can mirror those deletions
    const postsToDelete = ops.posts.deletes.map((del) => del.uri)
    const postsToCreate: DatabaseSchema['post'][] = []

    // Minimum ML confidence score (0–1) for an unknown author's post to be
    // included in the feed. Known Cincinnati users bypass this threshold.
    // Override via the CINCINNATI_THRESHOLD environment variable.
    const CINCINNATI_THRESHOLD = parseFloat(
      process.env.CINCINNATI_THRESHOLD ?? '0.4',
    )

    await Promise.all(
      ops.posts.creates.map(async (create) => {
        const actor = this.getAuthor(create.author)
        const postText = create.record.text ?? ''

        // Fast reject: skip posts with no connection to Cincinnati at all
        if (!actor && !hasCincinnatiKeywords(postText)) {
          // console.log(
          //   `[${create.uri}] No Cincinnati signal — skipping (not a known user, no keyword match)`,
          // )
          return Promise.resolve()
        }

        // Skip blocked authors
        if (actor && (actor.blocked || this.blockedUsers.includes(actor.did))) {
          console.log('Author is blocked, skipping post')
          return Promise.resolve()
        }

        // Fast label-based NSFW check (no ML cost)
        if (isNSFW(create.record.labels)) {
          return Promise.resolve()
        }

        // Run ML NSFW + Cincinnati relevance in parallel
        const [mlNSFW, mlScore] = await Promise.all([
          classifyNSFW(postText),
          classifyCincinnatiRelevance(postText),
        ])

        if (mlNSFW) {
          console.log(
            `[${create.uri}] ML flagged as NSFW — skipping (mlScore=${mlScore.toFixed(3)})`,
          )
          return Promise.resolve()
        }

        // Unknown-author posts must clear the Cincinnati relevance threshold
        if (!actor && mlScore < CINCINNATI_THRESHOLD) {
          console.log(
            `[${create.uri}] Below Cincinnati threshold — skipping (mlScore=${mlScore.toFixed(3)}, threshold=${CINCINNATI_THRESHOLD})`,
          )
          return Promise.resolve()
        }

        const validPost = await validatePostData({
          uri: create.uri,
          cid: create.cid,
          indexedAt: new Date().toISOString(),
          author: create.author,
          text: postText,
          mlScore,
        })

        if (validPost) {
          console.log(
            `Valid post ready for insertion: ${validPost.uri} (mlScore=${mlScore.toFixed(3)})`,
          )
          postsToCreate.push(validPost)
        } else {
          console.error('Post validation failed:', create)
        }
      }),
    )

    // console.log('\nBatch processing summary:', {
    //   toDelete: postsToDelete.length,
    //   toCreate: postsToCreate.length,
    // })

    // Mirror deletions — if a user deletes a post on Bluesky, remove it from
    // the feed database so it stops appearing in the feed skeleton.
    if (postsToDelete.length > 0) {
      try {
        this.db.deleteFrom('post').where('uri', 'in', postsToDelete).execute()
        console.log('Successfully deleted posts')
      } catch (err) {
        console.error('Failed to delete posts:', err)
      }
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

    // Persist the firehose cursor so the feed can resume from this position
    // after a restart instead of replaying the entire event history.
    this.db
      .updateTable('sub_state')
      .set({ cursor: parseInt(evt.seq.toString(), 10) })
      .where('service', '=', this.service)
      .execute()
  }

  // Reads the last known cursor from sub_state. If the table is empty (first
  // run) or the stored value is invalid, initialises/resets the cursor to 0,
  // which tells the firehose relay to start streaming from the live head.
  async getCursor(): Promise<{ cursor?: number }> {
    const res = await this.db
      .selectFrom('sub_state')
      .selectAll()
      .where('service', '=', this.service)
      .executeTakeFirst()

    if (!res) {
      console.warn('⚠️ sub_state table is empty. Initializing cursor at 0.')
      await this.db
        .insertInto('sub_state')
        .values({ service: this.service, cursor: 0 })
        .onConflict((oc) => oc.doNothing())
        .execute()
      return { cursor: 0 }
    }

    if (!Number.isInteger(res.cursor)) {
      console.error('🚨 Invalid cursor found:', res.cursor, '- Resetting to 0')
      await this.db
        .updateTable('sub_state')
        .set({ cursor: 0 })
        .where('service', '=', this.service)
        .execute()
      return { cursor: 0 }
    }

    console.log('✅ Loaded cursor:', res.cursor)
    return { cursor: res.cursor }
  }
}
