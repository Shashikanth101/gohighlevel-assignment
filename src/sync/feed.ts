import type { Api } from '../api/api'
import type { SyncEngine } from './engine'

export interface FeedOptions {
  pollMs: () => number
  onConnection?: (online: boolean) => void
}

/** Polls the server's change feed and hands confirmed teammate changes to the engine. */
export class Feed {
  private seq = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private polling = false
  online = true

  constructor(private api: Api, private engine: SyncEngine, private opts: FeedOptions) {}

  start(seq: number): void {
    this.seq = seq
    this.running = true
    this.schedule()
  }
  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
  private schedule(): void {
    if (!this.running) return
    this.timer = setTimeout(() => void this.pollNow(), this.opts.pollMs())
  }

  /** Fetch and apply changes now. Safe to call at any time; overlapping polls are skipped. */
  async pollNow(): Promise<void> {
    if (this.polling) return
    this.polling = true
    if (this.timer) clearTimeout(this.timer)
    try {
      const res = await this.api.changesSince(this.seq)
      this.seq = res.seq
      if (res.changes.length) this.engine.applyRemote(res.changes)
      this.setOnline(true)
    } catch {
      this.setOnline(false)
    } finally {
      this.polling = false
      this.schedule()
    }
  }
  private setOnline(v: boolean): void {
    if (v !== this.online) {
      this.online = v
      this.opts.onConnection?.(v)
    }
  }
}
