// SelfLabels | {
//     [k: string]: unknown;
//     $type: string;
// } | undefined

import { ComAtprotoLabelDefs } from '@atproto/api'
import { SelfLabels } from '../lexicon/types/com/atproto/label/defs'

export const isNSFW = (
  postLabels:
    | SelfLabels
    | {
        [k: string]: unknown
        $type: string
      }
    | undefined,
): boolean => {
  if (postLabels) {
    console.log('Post labels found:', postLabels)
    const labels = postLabels.values as
      | ComAtprotoLabelDefs.SelfLabel[]
      | undefined

    if (
      postLabels.$type === 'com.atproto.label.defs#selfLabels' &&
      labels?.some((label) =>
        [
          'porn',
          'nsfw',
          'sexual',
          'nsfw:explicit',
          'adult',
          'graphic-media',
        ].includes(label.val),
      )
    ) {
      console.log('Post contains blocked labels, skipping')
      return true
    }
  }

  return false
}
