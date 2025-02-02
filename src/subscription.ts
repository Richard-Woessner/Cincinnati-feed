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
import { chunkArray, isCincinnatiUser, sanitizeString } from './utils/helpers'
import { handleCincinnatiAuthor } from './features/users'
import { validatePostData } from './features/validatePostData'
import { cleanupNonCincinnatiPosts } from './features/cleanNonCincinnatiPosts'
import { isNSFW } from './features/isNSFW'

export class FirehoseSubscription extends FirehoseSubscriptionBase {
  private agent = new BskyAgent({ service: 'https://bsky.social' })
  private fileHandle: fs.FileHandle | null = null
  private blockedUsers: string[] = []
  private followersMap: FollowerMap[] = []
  private followingMap: FollowerMap[] = []
  private cincinnatiUsers: Actor[] = []

  constructor(db: Database, service: string) {
    super(db, service)
    console.log('Initializing FirehoseSubscription...')
    this.getCursor()
    this.initializeAgent().then(async () => {
      console.log('Agent initialized.')
      await this.getBlockedUsers()

      console.log(process.env.SEARCH_LOOP_ATTEMPTS)

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

      await this.getActorsDIDs()
      await cleanupNonCincinnatiPosts(db)
      console.log('Finished populating followers and following lists.')
    })
  }

  private async getActorsDIDs(): Promise<void> {
    const existing = await this.db.selectFrom('actor').selectAll().execute()

    this.cincinnatiUsers = existing.map((actor) => actor)

    return
  }

  // /blocked-users.txt
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

  private getAuthor(did: string) {
    // If post author is in actor table, add to post table
    return this.cincinnatiUsers.find((actor) => actor.did === did)
  }

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

  async handleEvent(evt: RepoEvent) {
    if (!isCommit(evt)) {
      console.log('Event is not a commit, skipping...')
      return
    }

    const ops = await getOpsByType(evt)

    const postsToDelete = ops.posts.deletes.map((del) => del.uri)
    const postsToCreate: DatabaseSchema['post'][] = []

    await Promise.all(
      ops.posts.creates.map(async (create) => {
        const actor = this.getAuthor(create.author)

        if (!actor) {
          console.log('Author not found in Cincinnati users list')
          return Promise.resolve()
        }

        const postLabels = create.record.labels
        if (isNSFW(postLabels)) {
          return Promise.resolve()
        }

        if (actor) {
          if (!actor.blocked && !this.blockedUsers.includes(actor.did)) {
            const validPost = await validatePostData({
              uri: create.uri,
              cid: create.cid,
              indexedAt: new Date().toISOString(),
              author: create.author,
              text: create.record.text,
            })

            if (validPost) {
              console.log('Valid post ready for insertion:', validPost.uri)
              postsToCreate.push(validPost)
            } else {
              console.error('Post validation failed:', create)
            }
          } else {
            console.log('Author is blocked, skipping post')
          }
        } else {
          console.log('Author not found in Cincinnati users list')
        }
      }),
    )

    // console.log('\nBatch processing summary:', {
    //   toDelete: postsToDelete.length,
    //   toCreate: postsToCreate.length,
    // })

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
        console.log('Successfully created posts')
      } catch (err) {
        console.error('Failed to create posts:', err)
      }
    }

    this.db
      .updateTable('sub_state')
      .set({ cursor: parseInt(evt.seq.toString(), 10) })
      .where('service', '=', this.service)
      .execute()
  }

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
