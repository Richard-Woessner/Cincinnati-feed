import { AppBskyActorDefs } from '@atproto/api'

export interface FollowerMap {
  userDid: string
  followers: AppBskyActorDefs.ProfileView[]
}

export interface ValidPostData {
  uri: string
  cid: string
  indexedAt: string
  author: string
  text: string
}
