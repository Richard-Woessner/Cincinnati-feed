export interface DatabaseSchema {
  post: {
    uri: string
    cid: string
    indexedAt: string
    author: string
    text: string // Add text column
  }
  actor: {
    did: string
    description: string
    blocked: boolean
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
  blocked: boolean
}
