import WebSocket from 'ws'
import { decompress } from 'fzstd'
import { Database } from '../db'

export type JetstreamRecord = {
  text?: string
  langs?: string[]
  labels?: unknown
  [key: string]: unknown
}

export type JetstreamCommit = {
  rev: string
  operation: 'create' | 'update' | 'delete'
  collection: string
  rkey: string
  cid?: string
  record?: JetstreamRecord
}

export type JetstreamEvent = {
  did: string
  time_us: number
  kind: 'commit' | 'identity' | 'account'
  commit?: JetstreamCommit
}

export abstract class FirehoseSubscriptionBase {
  constructor(
    public db: Database,
    public service: string,
  ) {}

  abstract handleEvent(evt: JetstreamEvent): Promise<void>

  async run(subscriptionReconnectDelay: number) {
    const { cursor } = await this.getCursor()
    const url =
      cursor && cursor > 0
        ? `${this.service}${this.service.includes('?') ? '&' : '?'}cursor=${cursor}`
        : this.service

    const ws = new WebSocket(url)

    ws.on('message', (data: WebSocket.RawData) => {
      let event: JetstreamEvent
      try {
        let raw: string
        if (Buffer.isBuffer(data) && data[0] !== 0x7b) {
          // compressed binary frame — decompress with zstd
          raw = new TextDecoder().decode(decompress(data))
        } else {
          raw = data.toString()
        }
        event = JSON.parse(raw) as JetstreamEvent
      } catch (err) {
        console.error('jetstream skipped non-JSON message', err)
        return
      }
      this.handleEvent(event).catch((err) => {
        console.error('jetstream subscription could not handle message', err)
      })
    })

    ws.on('close', () => {
      console.log('jetstream connection closed, reconnecting...')
      setTimeout(
        () => this.run(subscriptionReconnectDelay),
        subscriptionReconnectDelay,
      )
    })

    ws.on('error', (err) => {
      console.error('jetstream connection error', err)
    })
  }

  async updateCursor(cursor: number) {
    await this.db
      .updateTable('sub_state')
      .set({ cursor })
      .where('service', '=', this.service)
      .execute()
  }

  async getCursor(): Promise<{ cursor?: number }> {
    const res = await this.db
      .selectFrom('sub_state')
      .selectAll()
      .where('service', '=', this.service)
      .executeTakeFirst()
    return res ? { cursor: res.cursor } : {}
  }
}
