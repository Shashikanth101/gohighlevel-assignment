/** mulberry32: tiny, fast, seedable. Everything random in the app goes through this. */
export type Rng = () => number

export function makeRng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const randInt = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1))
export const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!

/** Weighted pick; weights need not sum to 1. */
export function pickWeighted<T>(r: Rng, xs: readonly T[], weights: readonly number[]): T {
  let total = 0
  for (const w of weights) total += w
  let x = r() * total
  for (let i = 0; i < xs.length; i++) {
    x -= weights[i]!
    if (x < 0) return xs[i]!
  }
  return xs[xs.length - 1]!
}
