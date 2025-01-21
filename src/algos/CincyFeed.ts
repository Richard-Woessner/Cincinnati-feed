import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'

// max 15 chars
export const shortname = 'CincyFeed'

export const handler = async (ctx: AppContext, params: QueryParams) => {
  let builder = ctx.db
    .selectFrom('post')
    .selectAll()
    .innerJoin('actor', 'actor.did', 'post.author')
    // Filter to only include posts where the user's profile description
    // matches one of the search terms ('cincinnati', 'cinci', or 'cincy')
    .where('actor.description', 'ilike', '%cincinnati%')
    .where('actor.description', 'ilike', '%cinci%')
    .where('actor.description', 'ilike', '%cincy%')
    .orderBy('indexedAt', 'desc')
    .orderBy('cid', 'desc')
    .limit(params.limit)

  if (params.cursor) {
    const timeStr = new Date(parseInt(params.cursor, 10)).toISOString()
    builder = builder.where('post.indexedAt', '<', timeStr)
  }
  const res = await builder.execute()

  const feed = res.forEach((row) => {
    console.log(row)

    return {
      post: row.uri,
    }
  })

  let cursor: string | undefined
  const last = res.at(-1)
  if (last) {
    cursor = new Date(last.indexedAt).getTime().toString(10)
  }

  // Then insert the posts with just the author reference
  const postsToCreate = res.map((post) => ({
    uri: post.uri,
    cid: post.cid,
    indexedAt: post.indexedAt,
    author: post.author, // Just store the DID as a string reference
  }))

  await ctx.db
    .insertInto('post')
    .values(postsToCreate)
    .onConflict((oc) => oc.doNothing())
    .execute()

  return {
    cursor,
    feed,
  }
}
