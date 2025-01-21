import { sql } from 'kysely'
import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'

export const shortname = 'CincyFeed'

export const handler = async (ctx: AppContext, params: QueryParams) => {
  let builder = ctx.db
    .selectFrom('post')
    .innerJoin('actor', 'actor.did', 'post.author')
    .where('actor.description', 'ilike', '%cincy%')
    .where('actor.description', 'ilike', '%cincinnati%')
    .where('actor.description', 'ilike', '%cinci%')
    .selectAll('post')
    .orderBy('indexedAt', 'desc')
    .orderBy('cid', 'desc')
    .limit(params.limit)

  if (params.cursor) {
    const timeStr = new Date(parseInt(params.cursor, 10)).toISOString()
    builder = builder.where('post.indexedAt', '<', timeStr)
  }

  const res = await builder.execute()

  const feed = res.map((row) => ({
    post: row.uri,
  }))

  let cursor: string | undefined
  const last = res.at(-1)
  if (last) {
    cursor = new Date(last.indexedAt).getTime().toString(10)
  }

  return {
    cursor,
    feed,
  }
}
