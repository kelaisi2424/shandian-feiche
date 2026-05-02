// V1.9.7-5: temporary in-race resume snapshot.
//
// Goal: when a user accidentally swipes away or backgrounds the tab
// mid-race, they should be able to come back within 10 minutes and
// continue from where they left off — instead of starting the level
// over from progress=0.
//
// Why a separate localStorage key from save.v1:
//   1. save.v1 is the long-term progression schema (unlocked levels,
//      leaderboard, settings). It must not gain or lose fields casually
//      — migrations are a chore.
//   2. Resume data is short-lived and lossy: TTL 10 min, drop on a
//      clean race finish, drop on a parse error. It's a UX nicety, not
//      truth.
// Two keys keeps the lifecycle isolated.
//
// The snapshot is intentionally tiny — six fields per the spec. A
// full state dump would be tempting but tying the schema to the
// internal state shape is fragile (field renames break resumes). We
// reconstruct the run from these six primitives instead.

const KEY = "shandian-feiche.resume.v1"
const TTL_MS = 10 * 60 * 1000

export function saveResumeSnapshot(snap) {
  if (typeof localStorage === "undefined") return
  try {
    const payload = {
      levelId: snap.levelId,
      progress: snap.progress,
      coins: snap.coins,
      hits: snap.hits,
      elapsedMs: snap.elapsedMs,
      nitroCharges: snap.nitroCharges,
      timestamp: Date.now(),
    }
    localStorage.setItem(KEY, JSON.stringify(payload))
  } catch (e) {
    // QuotaExceeded / SecurityError on private-mode WebViews — silent
    // failure is fine, we just lose the resume capability for this run.
  }
}

export function readResumeSnapshot() {
  if (typeof localStorage === "undefined") return null
  let raw
  try {
    raw = localStorage.getItem(KEY)
  } catch (_) {
    return null
  }
  if (!raw) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (_) {
    // Corrupt JSON — drop the key so we don't keep tripping over it.
    clearResumeSnapshot()
    return null
  }
  if (!parsed || typeof parsed !== "object") {
    clearResumeSnapshot()
    return null
  }
  if (typeof parsed.timestamp !== "number" ||
      typeof parsed.levelId !== "string" ||
      typeof parsed.progress !== "number") {
    clearResumeSnapshot()
    return null
  }
  if (Date.now() - parsed.timestamp > TTL_MS) {
    clearResumeSnapshot()
    return null
  }
  return parsed
}

export function clearResumeSnapshot() {
  if (typeof localStorage === "undefined") return
  try { localStorage.removeItem(KEY) } catch (_) {}
}

// Diagnostic accessor: window.__resume() in DevTools shows the live
// snapshot or null.
if (typeof window !== "undefined") {
  window.__resume = () => readResumeSnapshot()
  window.__resumeClear = clearResumeSnapshot
}
