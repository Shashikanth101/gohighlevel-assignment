import type { Deal, StageId } from '../domain/types'
import { DAY } from '../domain/priority'
import { makeRng, pick, pickWeighted, randInt } from './rng'

const ADJ = ['Apex', 'Bright', 'Cobalt', 'Delta', 'Evergreen', 'Fusion', 'Granite', 'Harbor', 'Indigo', 'Juniper', 'Keystone', 'Lumen', 'Meridian', 'Nimbus', 'Orbit', 'Pioneer', 'Quartz', 'Ridge', 'Summit', 'Talon', 'Unity', 'Vertex', 'Willow', 'Zenith']
const NOUN = ['Logistics', 'Retail', 'Health', 'Foods', 'Textiles', 'Motors', 'Realty', 'Labs', 'Finance', 'Media', 'Energy', 'Learning', 'Travel', 'Pharma', 'Steel', 'Software', 'Telecom', 'Agro']
const SUFFIX = ['Pvt Ltd', 'Ltd', 'Industries', 'Group', 'Co', 'Systems', 'Corp']

/** ~20% of deals sit in "New Lead", so a 50k pipeline has one 10k stage. */
const STAGE_WEIGHTS: Record<StageId, number> = {
  new: 20, contacted: 16, demo: 14, proposal: 12, negotiation: 8, won: 15, lost: 15,
}
const STAGE_IDS = Object.keys(STAGE_WEIGHTS) as StageId[]
const WEIGHTS = STAGE_IDS.map((s) => STAGE_WEIGHTS[s])

export function generateDeals(size: number, seed: number, now: number): Deal[] {
  const r = makeRng(seed)
  const out: Deal[] = new Array(size)
  for (let i = 0; i < size; i++) {
    const stage = pickWeighted(r, STAGE_IDS, WEIGHTS)
    const terminal = stage === 'won' || stage === 'lost'
    const lastActivityDays = Math.floor(-Math.log(1 - r()) * 8) // exponential, mean 8d
    // Dwell: usually fresh, with a long tail past the per-stage threshold.
    const dwellDays = Math.floor(-Math.log(1 - r()) * 7)
    // ln-normal-ish value, median ~3L, tail into the crores.
    const value = Math.round(Math.exp(12.6 + (r() + r() + r() - 1.5) * 2.2) / 1000) * 1000
    // Stage-aware "next step": New Lead = contact-by date (short window), open stages = follow-up, closed = none.
    const followUp = terminal
      ? null
      : stage === 'new'
        ? now + randInt(r, -3, 5) * DAY + randInt(r, 0, 20) * 3_600_000
        : now + randInt(r, -12, 14) * DAY + randInt(r, 0, 20) * 3_600_000
    // Won/Lost: ~12% closed within the last week (they show in Today), the rest 8+ days ago.
    const closedDays = terminal ? (r() < 0.12 ? randInt(r, 0, 6) : 8 + Math.floor(-Math.log(1 - r()) * 20)) : dwellDays
    const stageEntered = now - closedDays * DAY - randInt(r, 0, 23) * 3_600_000
    const closeOffset = randInt(r, terminal ? -30 : -4, terminal ? 0 : 60)
    out[i] = {
      id: `D-${String(i + 1).padStart(5, '0')}`,
      name: `${pick(r, ADJ)} ${pick(r, NOUN)} ${pick(r, SUFFIX)}`,
      licences: randInt(r, 1, 400),
      valueInr: Math.max(25_000, value),
      ownerId: randInt(r, 0, 19),
      stage,
      version: 1,
      lastActivityAt: now - lastActivityDays * DAY - randInt(r, 0, 23) * 3_600_000,
      stageEnteredAt: stageEntered,
      nextFollowUpAt: followUp,
      // Closed deals: the close date IS when they closed. Open deals: when they are expected to.
      expectedCloseAt: terminal ? stageEntered : now + closeOffset * DAY,
      updatedAt: stageEntered,
      updatedBy: randInt(r, 0, 19),
    }
  }
  return out
}
