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
    this.initializeAgent().then(async () => {
      console.log('Agent initialized.')
      await this.getBlockedUsers()

      // await this.SearchForCincinnatiUsers()
      await this.getActorsDIDs()
      await this.cleanupNonCincinnatiPosts()
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

      // Block users in the actor table
      for (const actor of actors) {
        console.log(`Blocking actor: ${actor}`)
        await this.db
          .updateTable('actor')
          .set({ blocked: 1 })
          .where('did', '=', actor)
          .execute()
      }

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

      for (const { did } of actors) {
        console.log(`Fetching followers for DID: ${did}`)
        const followers = await this.fetchFollowers(did)
        console.log(
          `Fetched ${followers.followers.length} followers for DID: ${did}`,
        )
        const following = await this.fetchFollowing(did)
        console.log(
          `Fetched ${following.followers.length} following for DID: ${did}`,
        )

        this.followersMap.push(followers)
        this.followingMap.push(following)
      }

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
          console.log(`Profile ${profile.did} has no description. Skipping.`)
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

      for (const did of actors) {
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
      }
      console.log('Successfully seeded actors from file.')
    } catch (err) {
      console.error('Failed to seed actors:', err)
    }
  }

  private async cleanupNonCincinnatiPosts() {
    console.log('Cleaning up non-Cincinnati and blocked user posts...')

    try {
      // Log the current state before deletion
      console.log('Preparing to delete posts...')

      // Remove actors whose bio does not contain 'cincy', 'cincinnati', or 'cinci'
      const actors = await this.db
        .selectFrom('actor')
        .select(['did', 'description'])
        .execute()

      console.log(
        `Checking ${actors.length} actors for Cincinnati relevance...`,
      )
      const nonCincyDids = actors
        .filter(
          (actor) => !actor.description || !isCincinnatiUser(actor.description),
        )
        .map((actor) => actor.did)

      console.log(
        `Found ${nonCincyDids.length} non-Cincinnati actors to remove.`,
      )

      if (nonCincyDids.length > 0) {
        await this.db
          .deleteFrom('actor')
          .where('did', 'in', nonCincyDids)
          .execute()

        console.log(`Removed ${nonCincyDids.length} non-Cincinnati actors.`)
      }
      await this.db
        .deleteFrom('post')
        .where('author', 'not in', this.db.selectFrom('actor').select('did'))
        .where(
          'author',
          'in',
          this.db.selectFrom('actor').select('did').where('blocked', '=', 1),
        )
        .execute()

      console.log('Cleaned up non-Cincinnati and blocked user posts.')
    } catch (err) {
      console.error('Failed to cleanup posts:', err)
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

  private validatePostData(post: any): ValidPostData | null {
    try {
      return {
        uri: String(post.uri),
        cid: String(post.cid),
        indexedAt: String(post.indexedAt),
        author: String(post.author),
        text: String(post.text),
      }
    } catch (err) {
      console.error('Invalid post data:', err)
      return null
    }
  }

  private async handleCincinnatiAuthor(did: string) {
    try {
      const existing = await this.db
        .selectFrom('actor')
        .select('did')
        .where('did', '=', did)
        .executeTakeFirst()

      if (existing) return

      const profile = await this.agent.getProfile({ actor: did })
      const bio = sanitizeString(profile.data.description)

      if (!isCincinnatiUser(bio)) return

      await this.db
        .insertInto('actor')
        .values({
          did: sanitizeString(did),
          description: bio,
          blocked: 0,
        })
        .onConflict((oc) => oc.doNothing())
        .execute()

      await fs.appendFile('./cincinnati-users.txt', `${did}\n`)
    } catch (err) {
      console.error('Error processing author:', err)
    }
  }

  async handleEvent(evt: RepoEvent) {
    if (!isCommit(evt)) {
      return
    }

    const ops = await getOpsByType(evt)

    const postsToDelete = ops.posts.deletes.map((del) => del.uri)

    const postsToCreate: DatabaseSchema['post'][] = []

    await Promise.all(
      ops.posts.creates.map(async (create) => {
        if (!create.record.text) {
          return
        }

        const postLabels:
          | ComAtprotoLabelDefs.SelfLabels
          | { $type: string; [k: string]: unknown }
          | undefined = create.record.labels

        if (postLabels != undefined) {
          console.log('Post labels:', postLabels)
          const labels = postLabels.values as
            | ComAtprotoLabelDefs.SelfLabel[]
            | undefined

          if (
            postLabels.$type === 'com.atproto.label.defs#selfLabels' &&
            labels != undefined &&
            labels.some(
              (label) =>
                label.val === 'porn' ||
                label.val === 'nsfw' ||
                label.val === 'sexual' ||
                label.val === 'nsfw:explicit' ||
                label.val === 'adult' ||
                label.val === 'graphic-media',
            )
          ) {
            console.log(`Post ${create.uri} contains blocked labels. Skipping.`)
            return // Skip adult content
          }
        }

        const actor = this.getAuthor(create.author)

        // If post contains cincy, cincinnati, or cinci, check the author's bio, and if it contains cincy, cincinnati, or cinci, add to actor table
        if (!actor && isCincinnatiUser(create.record.text)) {
          console.log(
            `Post ${create.uri} identified as Cincinnati user content.`,
          )
          await this.handleCincinnatiAuthor(create.author)
        }

        if (actor != undefined) {
          console.log(`Author ${create.author} found in actor table.`)
          if (!actor.blocked && !this.blockedUsers.includes(actor.did)) {
            const validPost = this.validatePostData({
              uri: create.uri,
              cid: create.cid,
              indexedAt: new Date().toISOString(),
              author: create.author,
              text: create.record.text,
            })

            if (validPost) {
              postsToCreate.push(validPost)
              console.log(`Valid post collected for insertion: ${create.uri}`)
            } else {
              console.error('Invalid post data:', create)
            }
          } else {
            console.log(
              `Author ${create.author} is blocked or in blocked users list. Skipping post ${create.uri}.`,
            )
          }
        } else {
          return
        }
      }),
    )

    if (postsToDelete.length > 0) {
      console.log(`Deleting ${postsToDelete.length} posts.`)
      try {
        await this.db
          .deleteFrom('post')
          .where('uri', 'in', postsToDelete)
          .execute()
        console.log('Successfully deleted posts.')
      } catch (err) {
        console.error('Failed to delete posts:', err)
      }
    } else {
    }

    if (postsToCreate.length > 0) {
      console.log(`Inserting ${postsToCreate.length} new posts.`)
      try {
        await this.db
          .insertInto('post')
          .values(postsToCreate)
          .onConflict((oc) => oc.doNothing())
          .execute()
        console.log('Successfully inserted new posts.')
      } catch (err) {
        console.error('Failed to insert new posts:', err)
      }
    } else {
    }

    // Ensure cursor is an integer before updating
    const cursorInt = parseInt(String(evt.seq), 10)
    if (isNaN(cursorInt)) {
      console.error('Invalid cursor value:', evt.seq)
      return
    }

    // Add cursor update after handling posts
    try {
      await this.db
        .updateTable('sub_state')
        .set({ cursor: cursorInt })
        .where('service', '=', this.service)
        .execute()
    } catch (err) {
      console.error('Failed to update cursor:', err)
    }
  }

  async getCursor(): Promise<{ cursor?: number }> {
    console.log('Fetching cursor from sub_state table.')

    try {
      const res = await this.db
        .selectFrom('sub_state')
        .selectAll()
        .where('service', '=', this.service)
        .executeTakeFirst()

      if (!res) {
        console.warn('sub_state table is empty. Inserting default cursor.')

        await this.db
          .insertInto('sub_state')
          .values({ service: this.service, cursor: 0 })
          .onConflict((oc) => oc.doNothing())
          .execute()

        return { cursor: 0 } // Return default cursor
      }

      if (!Number.isInteger(res.cursor)) {
        console.error('Invalid cursor found:', res.cursor)
        return { cursor: 0 } // Return default
      }

      console.log('Cursor fetched:', res.cursor)
      return { cursor: res.cursor }
    } catch (err) {
      console.error('Failed to get cursor:', err)
      return { cursor: 0 } // Return default on failure
    }
  }
}
