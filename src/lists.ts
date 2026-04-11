import { AtpAgent } from '@atproto/api'

// DIDs muted by the feed publisher — their posts are always skipped.
export const mutedDids = new Set<string>()

// DIDs on the Cincinnati whitelist — their posts always pass through all filters.
export const whitelistedDids = new Set<string>()

const WHITELIST_URI =
  'at://cincyfeed.bsky.social/app.bsky.graph.list/3mjahfqwzun2y'

// Refreshes both the mutes and whitelist sets in parallel.
// Call at startup and periodically (e.g. every 10 minutes).
export async function refreshLists(agent: AtpAgent): Promise<void> {
  await Promise.all([loadMutes(agent), loadWhitelist(agent)])
}

async function loadMutes(agent: AtpAgent): Promise<void> {
  mutedDids.clear()
  let cursor: string | undefined

  do {
    const res = await agent.api.app.bsky.graph.getMutes({
      limit: 100,
      cursor,
    })
    for (const actor of res.data.mutes) {
      mutedDids.add(actor.did)
    }
    cursor = res.data.cursor
  } while (cursor)

  console.log(`Loaded ${mutedDids.size} muted account(s).`)
}

async function loadWhitelist(agent: AtpAgent): Promise<void> {
  whitelistedDids.clear()
  let cursor: string | undefined

  do {
    const res = await agent.api.app.bsky.graph.getList({
      list: WHITELIST_URI,
      limit: 100,
      cursor,
    })
    for (const item of res.data.items) {
      whitelistedDids.add(item.subject.did)
    }
    cursor = res.data.cursor
  } while (cursor)

  console.log(`Loaded ${whitelistedDids.size} whitelisted account(s).`)
}
