import { DAY } from './priority'
import type { Deal } from './types'
import { ME } from './types'

export interface NewDealInput {
  name: string
  valueInr: number
  licences: number
}

/** Why `input` can't be saved, or null. Shared by the form and the engine. */
export function validateNewDeal(i: NewDealInput): string | null {
  if (!i.name.trim()) return 'Enter a deal name'
  if (!Number.isFinite(i.valueInr) || i.valueInr <= 0) return 'Enter a value above ₹0'
  if (!Number.isInteger(i.licences) || i.licences < 1) return 'Licences must be a whole number, at least 1'
  return null
}

/** A fresh New Lead owned by me. The client's optimistic row and the server's row are built the same way. */
export function buildNewDeal(id: string, i: NewDealInput, now: number, version: number): Deal {
  return {
    id, name: i.name.trim(), licences: i.licences, valueInr: Math.round(i.valueInr), ownerId: ME, stage: 'new', version,
    lastActivityAt: now, stageEnteredAt: now,
    nextFollowUpAt: now + DAY, // "contact by": tomorrow
    expectedCloseAt: now + 30 * DAY, updatedAt: now, updatedBy: ME,
  }
}
