import {
  OutputSchema as RepoEvent,
  isCommit,
} from './lexicon/types/com/atproto/sync/subscribeRepos'
import {
  AppBskyActorDefs,
  AppBskyActorGetProfiles,
  BskyAgent,
} from '@atproto/api'
import { FirehoseSubscriptionBase, getOpsByType } from './util/subscription'
import * as fs from 'fs/promises'
import { Database } from './db'
import { DatabaseSchema } from './db/schema'
import path from 'path'
import { ProfileView } from '@atproto/api/dist/client/types/app/bsky/actor/defs'

interface FollowerMap {
  userDid: string
  followers: AppBskyActorDefs.ProfileView[]
}

export class FirehoseSubscription extends FirehoseSubscriptionBase {
  private agent = new BskyAgent({ service: 'https://bsky.social' })
  private fileHandle: fs.FileHandle | null = null

  private followersMap: FollowerMap[] = [] // Stores followers
  private followingMap: FollowerMap[] = [] // Stores following

  constructor(db: Database, service: string) {
    super(db, service)
    this.initializeAgent().then(async () => {
      await this.seedActorsFromFile()
      await this.populateFollowers()
      await this.cleanupNonCincinnatiPosts()

      await this.SearchForCincinnatiUsers()
      console.log('Finished populating followers and following lists.')
    })
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

        // If post contains cincy, cincinnati, or cinci, check the author's bio, and if it contains cincy, cincinnati, or cinci, add to actor table
        if (this.isCincinnatiUser(create.record.text)) {
          try {
            const profile = await this.agent.getProfile({
              actor: create.author,
            })
            const bio = profile.data.description

            if (bio && /cincy|cincinnati|cinci/i.test(bio)) {
              // Add to actor table
              await this.db
                .insertInto('actor')
                .values({ did: create.author, description: bio })
                .onConflict((oc) => oc.doNothing())
                .execute()

              await fs.appendFile(
                './cincinnati-users.txt',
                `${create.author}\n`,
              )
            }
          } catch (err) {
            console.error('Error processing post:', err)
          }
        }

        // If post author is in actor table, add to post table
        const actor = await this.db
          .selectFrom('actor')
          .selectAll()
          .where('did', '=', create.author)
          .executeTakeFirst()

        if (actor) {
          postsToCreate.push({
            uri: create.uri,
            cid: create.cid,
            indexedAt: new Date().toISOString(),
            author: create.author,
            text: create.record.text,
          })
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
