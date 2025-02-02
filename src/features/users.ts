import { BskyAgent } from '@atproto/api'
import * as fs from 'fs/promises'
import { Database } from '../db'
import { Actor } from '../db/schema'
import { sanitizeString, isCincinnatiUser } from '../utils/helpers'

export async function handleCincinnatiAuthor(
  db: Database,
  agent: BskyAgent,
  cincinnatiUsers: Actor[],
  did: string,
): Promise<void> {
  try {
    const existing = cincinnatiUsers.find((actor) => actor.did === did)

    if (existing) return

    const profile = await agent.getProfile({ actor: did })
    const bio = sanitizeString(profile.data.description)

    if (!isCincinnatiUser(bio)) return

    await db
      .insertInto('actor')
      .values({
        did: did,
        description: sanitizeString(bio),
        blocked: 0,
      })
      .onConflict((oc) => oc.doNothing())
      .execute()

    await fs.appendFile('./cincinnati-users.txt', `${did}\n`)
  } catch (err) {
    console.error('Error processing author:', err)
  }
}

export default handleCincinnatiAuthor
