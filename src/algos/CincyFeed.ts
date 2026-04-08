import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'

// max 15 chars
export const shortname = 'CincyFeed'

export const handler = async (ctx: AppContext, params: QueryParams) => {
  let builder = ctx.db
    .selectFrom('post')
    .leftJoin('actor', 'post.author', 'actor.did')
    .select([
      'post.uri',
      'post.cid',
      'post.indexedAt',
      'post.author',
      'post.text',
      'post.mlScore',
    ])
    .where((eb) =>
      eb.or([
        eb('actor.blocked', 'is', null),
        eb('actor.blocked', '!=', 1),
      ]),
    )
    .orderBy('post.indexedAt', 'desc')
    .orderBy('post.cid', 'desc')
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
