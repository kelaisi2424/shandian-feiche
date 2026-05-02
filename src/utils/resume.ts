// V3 D3 (B): in-race resume snapshot.
//
// Cherry-picked + adapted from main-kid-archive's V1.9.7-5
// src/utils/resume.js. Same idea ("survive a tab dismiss / background"),
// new schema for the pmndrs cannon-vehicle:
//
//   pos        [x, y, z]     world position of chassis
//   rot        [rx, ry, rz]  Euler rotation
//   speed      number        cached mutation.speed (km/h)
//   boost      number        cached mutation.boost (0..maxBoost)
//   elapsedMs  number        Date.now() - state.start at write time
//   timestamp  number        Date.now() at write
//
// Storage key is independent of any other localStorage in this site
// (none right now anyway, but keeps options open). TTL 10 min.

const KEY = 'pmndrs-racer.resume.v1'
const TTL_MS = 10 * 60 * 1000

export interface ResumeSnap {
  pos?: [number, number, number]
  rot?: [number, number, number]
  speed?: number
  boost?: number
  elapsedMs?: number
  timestamp?: number
}

export function saveResumeSnapshot(snap: ResumeSnap): void {
  if (typeof localStorage === 'undefined') return
  try {
    const payload: ResumeSnap = {
      pos: snap.pos,
      rot: snap.rot,
      speed: snap.speed,
      boost: snap.boost,
      elapsedMs: snap.elapsedMs,
      timestamp: Date.now(),
    }
    localStorage.setItem(KEY, JSON.stringify(payload))
  } catch (_) {
    /* QuotaExceeded / SecurityError on private-mode → silent fail */
  }
}

export function readResumeSnapshot(): ResumeSnap | null {
  if (typeof localStorage === 'undefined') return null
  let raw
  try {
    raw = localStorage.getItem(KEY)
  } catch (_) {
    return null
  }
  if (!raw) return null
  let parsed: ResumeSnap | null = null
  try {
    parsed = JSON.parse(raw)
  } catch (_) {
    clearResumeSnapshot()
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    clearResumeSnapshot()
    return null
  }
  if (typeof parsed.timestamp !== 'number') {
    clearResumeSnapshot()
    return null
  }
  if (Date.now() - parsed.timestamp > TTL_MS) {
    clearResumeSnapshot()
    return null
  }
  return parsed
}

export function clearResumeSnapshot(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(KEY)
  } catch (_) {
    /* noop */
  }
}

// Diagnostic accessor for DevTools.
declare global {
  interface Window {
    __resume?: () => ResumeSnap | null
    __resumeClear?: () => void
  }
}
if (typeof window !== 'undefined') {
  window.__resume = readResumeSnapshot
  window.__resumeClear = clearResumeSnapshot
}
