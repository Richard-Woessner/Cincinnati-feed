import { ValidPostData } from '../types'

export async function validatePostData(
  post: any,
): Promise<ValidPostData | null> {
  try {
    return {
      uri: String(post.uri),
      cid: String(post.cid),
      indexedAt: String(post.indexedAt),
      author: String(post.author),
      text: String(post.text),
    }
  } catch (err) {
    console.error('Invalid post data:', err)
    return null
  }
}
