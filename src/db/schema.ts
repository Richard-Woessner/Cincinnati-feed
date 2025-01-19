export interface DatabaseSchema {
  post: {
    uri: string
    cid: string
    indexedAt: string
    author: string
  }
  actor: {
    did: string
    description: string
  }
  sub_state: {
    // Add this missing table
    service: string
    cursor: number
  }
}

export type Post = {
  uri: string
  cid: string
  indexedAt: string
  author: Actor
}

export type SubState = {
  service: string
  cursor: number
}

export type Actor = {
  did: string
  description: string
}
