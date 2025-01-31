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
import { ProfileView } from '@atproto/api/dist/client/types/app/bsky/actor/defs'
import { SelfLabels } from './lexicon/types/com/atproto/label/defs'

interface FollowerMap {
  userDid: string
  followers: AppBskyActorDefs.ProfileView[]
}

// Create interface for post data validation
interface ValidPostData {
  uri: string
  cid: string
  indexedAt: string
  author: string
  text: string
}

export class FirehoseSubscription extends FirehoseSubscriptionBase {
  private agent = new BskyAgent({ service: 'https://bsky.social' })
  private fileHandle: fs.FileHandle | null = null

  private blockedUsers: string[] = [] // Stores blocked users

  private followersMap: FollowerMap[] = [] // Stores followers
  private followingMap: FollowerMap[] = [] // Stores following

  constructor(db: Database, service: string) {
    super(db, service)
    this.initializeAgent().then(async () => {
      await this.getBlockedUsers()
      await this.seedActorsFromFile()
      await this.populateFollowers()
      await this.cleanupNonCincinnatiPosts()

      await this.SearchForCincinnatiUsers()
      console.log('Finished populating followers and following lists.')
    })
  }

  // /blocked-users.txt
  private async getBlockedUsers() {
    try {
      const filePath = path.join(process.cwd(), 'blocked-users.txt')
      const fileContent = await fs.readFile(filePath, 'utf-8')
      const actors = fileContent.trim().split('\n')

      this.blockedUsers.push(...actors)
    } catch (err) {
      console.error('Failed to get blocked users:', err)
    }
  }

  private async populateFollowers() {
    try {
      const actors = await this.db.selectFrom('actor').select(['did']).execute()

      for (const { did } of actors) {
        const followers = await this.fetchFollowers(did)
        const following = await this.fetchFollowing(did)

        this.followersMap.push(followers)
        this.followingMap.push(following)
      }

      console.log('Successfully populated followers and following lists')
    } catch (err) {
      console.error('Failed to populate followers:', err)
    }
  }

  private async fetchFollowers(did: string): Promise<FollowerMap> {
    try {
      const { data } = await this.agent.api.app.bsky.graph.getFollowers({
        actor: did,
        limit: 100, // Adjust as needed
      })

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

      return {
        userDid: did,
        followers: data.follows,
      }
    } catch (err) {
      console.error(`Failed to fetch following for ${did}:`, err)
      return { userDid: did, followers: [] }
    }
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    return Array.from({ length: Math.ceil(array.length / size) }, (_, i) =>
      array.slice(i * size, i * size + size),
    )
  }

  private async fetchProfiles(dids: string[]) {
    const chunks = this.chunkArray(dids, 25)
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
    for (const followers of this.followersMap) {
      const dids = followers.followers.map((f) => f.did)
      const profiles = await this.fetchProfiles(dids)

      for (const profile of profiles) {
        if (!profile.description) continue

        const exists = await this.db
          .selectFrom('actor')
          .selectAll()
          .where('did', '=', profile.did)
          .executeTakeFirst()

        if (!exists && this.isCincinnatiUser(profile.description)) {
          await this.db
            .insertInto('actor')
            .values({
              did: profile.did,
              description: profile.description,
              blocked: false,
            })
            .onConflict((oc) => oc.doNothing())
            .execute()
        }
      }
    }
  }

  private async seedActorsFromFile() {
    try {
      const filePath = path.join(process.cwd(), 'cincinnati-users.txt')
      const fileContent = await fs.readFile(filePath, 'utf-8')
      const actors = fileContent.trim().split('\n')

      for (const did of actors) {
        try {
          const profile = await this.agent.getProfile({ actor: did })
          await this.db
            .insertInto('actor')
            .values({
              did: did,
              description: profile.data.description || '',
              blocked: false,
            })
            .onConflict((oc) => oc.doNothing())
            .execute()
        } catch (err) {
          console.error(`Failed to seed actor ${did}:`, err)
        }
      }
      console.log('Successfully seeded actors from file')
    } catch (err) {
      console.error('Failed to seed actors:', err)
    }
  }

  private isCincinnatiUser(bio: string | null): boolean {
    let isCincinnati = Boolean(bio && /cincy|cincinnati|cinci/i.test(bio))

    if (isCincinnati) {
      console.log('Cincinnati User:', bio)
    }

    return isCincinnati
  }

  private async cleanupNonCincinnatiPosts() {
    try {
      await this.db
        .deleteFrom('post')
        .where('author', 'not in', this.db.selectFrom('actor').select('did'))
        .execute()
      console.log('Cleaned up non-Cincinnati posts')
    } catch (err) {
      console.error('Failed to cleanup posts:', err)
    }
  }

  async initializeAgent() {
    await this.agent.login({
      identifier: process.env.FEEDGEN_PUBLISHER_DID!,
      password: process.env.BLUESKY_PASSWORD!,
    })
  }

  // Add validation function
  private validatePostData(post: any): ValidPostData | null {
    try {
      return {
        uri: String(post.uri),
        cid: String(post.cid),
        indexedAt: String(post.indexedAt),
        author: String(post.author),
        text: String(post.record.text || ''),
      }
    } catch (err) {
      console.error('Invalid post data:', err)
      return null
    }
  }

  private isString(value: unknown): value is string {
    return typeof value === 'string'
  }

  private sanitizeString(value: unknown): string {
    // Convert non-string values to empty strings or stringified JSON
    if (this.isString(value)) {
      // Optionally remove line breaks that can cause issues
      return value.replace(/\r?\n|\n/g, ' ')
    }
    return ''
  }

  private async handleCincinnatiAuthor(did: string) {
    try {
      const profile = await this.agent.getProfile({ actor: did })
      const bioRaw = profile.data.description
      const bio = this.sanitizeString(bioRaw)

      // Insert the actor row with proper types
      await this.db
        .insertInto('actor')
        .values({
          did: this.sanitizeString(did), // Ensure DID is a string
          description: bio, // Ensure it's a plain string
          blocked: false, // Kysely should handle booleans in SQLite
        })
        .onConflict((oc) => oc.doNothing())
        .execute()

      // Optionally append to file if needed
      await fs.appendFile('./cincinnati-users.txt', `${did}\n`)
    } catch (err) {
      console.error('Error processing author:', err)
    }
  }

  async handleEvent(evt: RepoEvent) {
    if (!isCommit(evt)) return

    const ops = await getOpsByType(evt)

    // // This logs the text of every post off the firehose.
    // // Just for fun :)
    // // Delete before actually using
    // for (const p of ops.profiles.creates) {
    //   console.log(p.record.description)
    // }

    const postsToDelete = ops.posts.deletes.map((del) => del.uri)
    const postsToCreate: DatabaseSchema['post'][] = []

    await Promise.all(
      ops.posts.creates.map(async (create) => {
        // if /cincy|cincinnati|cinci/i.test(create.record.text)

        if (!create.record.text) return

        const postLabels:
          | ComAtprotoLabelDefs.SelfLabels
          | { $type: string; [k: string]: unknown }
          | undefined = create.record.labels

        if (postLabels != undefined) {
          const labels = postLabels.values as
            | ComAtprotoLabelDefs.SelfLabel[]
            | undefined

          console.log(postLabels)
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
            console.log(`Blocked NSFW/Adult content post: ${create.uri}`)
            return // Skip adult content
          }
        }

        // If post contains cincy, cincinnati, or cinci, check the author's bio, and if it contains cincy, cincinnati, or cinci, add to actor table
        if (this.isCincinnatiUser(create.record.text)) {
          await this.handleCincinnatiAuthor(create.author)
        }

        // If post author is in actor table, add to post table
        const actor = await this.db
          .selectFrom('actor')
          .selectAll()
          .where('did', '=', create.author)
          .executeTakeFirst()

        if (actor && !actor.blocked && !this.blockedUsers.includes(actor.did)) {
          const validPost = this.validatePostData({
            uri: create.uri,
            cid: create.cid,
            indexedAt: new Date().toISOString(),
            author: create.author,
            text: create.record.text,
          })

          if (validPost) {
            postsToCreate.push(validPost)
          }
        }
      }),
    )

    if (postsToDelete.length > 0) {
      await this.db
        .deleteFrom('post')
        .where('uri', 'in', postsToDelete)
        .execute()
    }

    if (postsToCreate.length > 0) {
      await this.db
        .insertInto('post')
        .values(postsToCreate)
        .onConflict((oc) => oc.doNothing())
        .execute()
    }

    // Add cursor update after handling posts
    await this.db
      .updateTable('sub_state')
      .set({ cursor: evt.seq })
      .where('service', '=', this.service)
      .execute()
  }

  async getCursor(): Promise<{ cursor?: number }> {
    const res = await this.db
      .selectFrom('sub_state')
      .selectAll()
      .where('service', '=', this.service)
      .executeTakeFirst()

    // Return an object with the cursor property to match the base class type
    return { cursor: res?.cursor }
  }
}
