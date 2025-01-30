import {
  OutputSchema as RepoEvent,
  isCommit,
} from './lexicon/types/com/atproto/sync/subscribeRepos'
import { BskyAgent } from '@atproto/api'
import { FirehoseSubscriptionBase, getOpsByType } from './util/subscription'
import * as fs from 'fs/promises'
import { Database } from './db'
import { DatabaseSchema } from './db/schema'
import path from 'path'

export class FirehoseSubscription extends FirehoseSubscriptionBase {
  private agent = new BskyAgent({ service: 'https://bsky.social' })
  private fileHandle: fs.FileHandle | null = null

  constructor(db: Database, service: string) {
    super(db, service)
    this.initializeAgent().then(() => {
      this.seedActorsFromFile()
    })
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
        if (
          create.record.text.includes('cincy') ||
          create.record.text.includes('cincinnati') ||
          create.record.text.includes('cinci')
        ) {
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

            postsToCreate.push({
              uri: create.uri,
              cid: create.cid,
              indexedAt: new Date().toISOString(),
              author: create.author,
              text: create.record.text,
            })
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
