import { Database } from '../db'
import { isCincinnatiUser, logger } from '../utils/helpers'

export async function cleanupNonCincinnatiPosts(db: Database): Promise<void> {
  logger.info('Cleaning up non-Cincinnati and blocked user posts...')

  try {
    logger.debug('Preparing to delete posts...')

    // Remove actors whose bio does not contain 'cincy', 'cincinnati', or 'cinci'
    const actors = await db
      .selectFrom('actor')
      .select(['did', 'description'])
      .execute()

    logger.info(`Checking ${actors.length} actors for Cincinnati relevance...`)
    const nonCincyDids = actors
      .filter(
        (actor) => !actor.description || !isCincinnatiUser(actor.description),
      )
      .map((actor) => actor.did)

    logger.info(`Found ${nonCincyDids.length} non-Cincinnati actors to remove.`)

    if (nonCincyDids.length > 0) {
      await db.deleteFrom('actor').where('did', 'in', nonCincyDids).execute()

      logger.info(`Removed ${nonCincyDids.length} non-Cincinnati actors.`)
    }
    // Delete posts whose author is not in the actor table
    await db
      .deleteFrom('post')
      .where('author', 'not in', db.selectFrom('actor').select('did'))
      .execute()

    // Delete posts whose author is blocked
    await db
      .deleteFrom('post')
      .where(
        'author',
        'in',
        db.selectFrom('actor').select('did').where('blocked', '=', 1),
      )
      .execute()

    logger.info('Cleaned up non-Cincinnati and blocked user posts.')
  } catch (err) {
    logger.error('Failed to cleanup posts:', err)
  }
}
