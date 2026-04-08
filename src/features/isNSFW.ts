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

const NSFW_LABEL_VALUES = [
  'porn',
  'nsfw',
  'sexual',
  'nsfw:explicit',
  'adult',
  'graphic-media',
]

export const isNSFWProfile = (
  labels: ComAtprotoLabelDefs.Label[] | undefined,
): boolean => {
  if (!labels || labels.length === 0) return false
  return labels.some((label) => NSFW_LABEL_VALUES.includes(label.val))
}
