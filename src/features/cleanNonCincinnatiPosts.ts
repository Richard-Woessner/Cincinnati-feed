import { Database } from '../db'
import { isCincinnatiUser } from '../utils/helpers'

export async function cleanupNonCincinnatiPosts(db: Database): Promise<void> {
  console.log('Cleaning up non-Cincinnati and blocked user posts...')

  try {
    // Log the current state before deletion
    console.log('Preparing to delete posts...')

    // Remove actors whose bio does not contain 'cincy', 'cincinnati', or 'cinci'
    const actors = await db
      .selectFrom('actor')
      .select(['did', 'description'])
      .execute()

    console.log(`Checking ${actors.length} actors for Cincinnati relevance...`)
    const nonCincyDids = actors
      .filter(
        (actor) => !actor.description || !isCincinnatiUser(actor.description),
      )
      .map((actor) => actor.did)

    console.log(`Found ${nonCincyDids.length} non-Cincinnati actors to remove.`)

    if (nonCincyDids.length > 0) {
      await db.deleteFrom('actor').where('did', 'in', nonCincyDids).execute()

      console.log(`Removed ${nonCincyDids.length} non-Cincinnati actors.`)
    }
    await db
      .deleteFrom('post')
      .where('author', 'not in', db.selectFrom('actor').select('did'))
      .where(
        'author',
        'in',
        db.selectFrom('actor').select('did').where('blocked', '=', 1),
      )
      .execute()

    console.log('Cleaned up non-Cincinnati and blocked user posts.')
  } catch (err) {
    console.error('Failed to cleanup posts:', err)
  }
}
