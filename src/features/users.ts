import { AtpAgent } from '@atproto/api'
import * as fs from 'fs/promises'
import { Database } from '../db'
import { Actor } from '../db/schema'
import { sanitizeString } from '../utils/helpers'
import { classifyCincinnatiRelevance } from './mlClassifier'
import { isNSFWProfile } from './isNSFW'

const PROFILE_CINCINNATI_THRESHOLD = parseFloat(
  process.env.PROFILE_CINCINNATI_THRESHOLD ?? '0.6',
)

export async function handleCincinnatiAuthor(
  db: Database,
  agent: AtpAgent,
  cincinnatiUsers: Actor[],
  did: string,
): Promise<void> {
  try {
    const existing = cincinnatiUsers.find((actor) => actor.did === did)

    if (existing) return

    const profile = await agent.getProfile({ actor: did })

    if (isNSFWProfile(profile.data.labels)) {
      console.log(`[${did}] Profile is NSFW — skipping`)
      return
    }

    const name = profile.data.displayName ?? ''
    const bio = sanitizeString(profile.data.description)
    const bioScore = await classifyCincinnatiRelevance(bio ?? '')

    if (bioScore < PROFILE_CINCINNATI_THRESHOLD) {
      console.log(
        `[${did}] Profile bio below Cincinnati threshold — skipping (bioScore=${bioScore.toFixed(3)})`,
      )
      return
    }

    await db
      .insertInto('actor')
      .values({
        did: did,
        name: sanitizeString(name) ?? '',
        description: sanitizeString(bio),
        blocked: 0,
      })
      .onConflict((oc) => oc.doNothing())
      .execute()

    cincinnatiUsers.push({
      did,
      name: sanitizeString(name) ?? '',
      description: sanitizeString(bio),
      blocked: 0,
    })

    const filePath = './cincinnati-users.json'
    const fileUsers = JSON.parse(
      await fs.readFile(filePath, 'utf-8').catch(() => '[]'),
    ) as { did: string; name: string; bio: string }[]
    fileUsers.push({ did, name, bio: bio ?? '' })
    await fs.writeFile(filePath, JSON.stringify(fileUsers, null, 2))
  } catch (err) {
    console.error('Error processing author:', err)
  }
}

export default handleCincinnatiAuthor
