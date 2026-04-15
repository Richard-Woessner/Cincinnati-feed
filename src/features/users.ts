import { AtpAgent } from '@atproto/api'
import * as fs from 'fs/promises'
import { Database } from '../db'
import { Actor } from '../db/schema'
import { sanitizeString, logger } from '../utils/helpers'
import { classifyCincinnatiRelevance } from './mlClassifier'
import { isNSFWProfile } from './isNSFW'

const PROFILE_CINCINNATI_THRESHOLD = parseFloat(
  process.env.PROFILE_CINCINNATI_THRESHOLD ?? '0.6',
)

const FOLLOW_CINCINNATI_THRESHOLD = parseFloat(
  process.env.FOLLOW_CINCINNATI_THRESHOLD ?? '0.9',
)

export async function handleCincinnatiAuthor(
  db: Database,
  agent: AtpAgent,
  cincinnatiUsers: Actor[],
  did: string,
  blockedUsers: string[] = [],
): Promise<void> {
  try {
    if (blockedUsers.includes(did)) {
      logger.debug(`[${did}] DID is blocked — skipping handleCincinnatiAuthor`)
      return
    }

    const existing = cincinnatiUsers.find((actor) => actor.did === did)

    if (existing) return

    const profile = await agent.getProfile({ actor: did })

    if (isNSFWProfile(profile.data.labels)) {
      logger.debug(`[${did}] Profile is NSFW — skipping`)
      return
    }

    const name = profile.data.displayName ?? ''
    const bio = sanitizeString(profile.data.description)
    const bioScore = await classifyCincinnatiRelevance(bio ?? '')

    if (bioScore < PROFILE_CINCINNATI_THRESHOLD) {
      logger.debug(
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
      .onConflict((oc) =>
        oc.column('did').doUpdateSet((eb) => ({
          name: eb.ref('excluded.name'),
        })),
      )
      .execute()

    cincinnatiUsers.push({
      did,
      name: sanitizeString(name) ?? '',
      description: sanitizeString(bio),
      blocked: 0,
    })

    if (bioScore >= FOLLOW_CINCINNATI_THRESHOLD) {
      try {
        await agent.api.app.bsky.graph.follow.create(
          { repo: process.env.FEEDGEN_PUBLISHER_DID! },
          { subject: did, createdAt: new Date().toISOString() },
        )
        logger.info(
          `[${did}] Auto-followed — Cincinnati bio score ${bioScore.toFixed(3)} >= ${FOLLOW_CINCINNATI_THRESHOLD}`,
        )
      } catch (followErr) {
        logger.error(`[${did}] Failed to auto-follow:`, followErr)
      }
    }

    const filePath = './cincinnati-users.json'
    const fileUsers = JSON.parse(
      await fs.readFile(filePath, 'utf-8').catch(() => '[]'),
    ) as { did: string; name: string; bio: string }[]
    fileUsers.push({ did, name, bio: bio ?? '' })
    await fs.writeFile(filePath, JSON.stringify(fileUsers, null, 2))
  } catch (err) {
    logger.error('Error processing author:', err)
  }
}

export default handleCincinnatiAuthor
