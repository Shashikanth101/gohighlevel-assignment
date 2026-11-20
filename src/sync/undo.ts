import type { DealPatch } from '../domain/types'

export type UndoItem =
  | { kind: 'edit'; label: string; items: { id: string; patch: DealPatch }[] }
  | { kind: 'job'; label: string; jobId: string }

/** Bounded LIFO of undoable user actions. Undoing issues NEW mutations; nothing is rolled back in place. */
export class UndoStack {
  private stack: UndoItem[] = []
  constructor(private limit = 50) {}
  push(item: UndoItem): void {
    this.stack.push(item)
    if (this.stack.length > this.limit) this.stack.shift()
  }
  pop(): UndoItem | undefined {
    return this.stack.pop()
  }
  peek(): UndoItem | undefined {
    return this.stack[this.stack.length - 1]
  }
  remove(item: UndoItem): void {
    this.stack = this.stack.filter((i) => i !== item)
  }
  get size(): number {
    return this.stack.length
  }
  clear(): void {
    this.stack = []
  }
}
