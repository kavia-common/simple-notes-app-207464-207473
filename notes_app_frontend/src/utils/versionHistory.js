/**
 * Note version history helpers (frontend-only).
 *
 * Stores per-note snapshots in localStorage.
 * This is intentionally simple and dependency-free.
 */

const HISTORY_KEY_PREFIX = "retro_notes_history_v1:";

// Keep history small to avoid exceeding localStorage quotas.
const DEFAULT_MAX_SNAPSHOTS = 25;

/**
 * @typedef {Object} NoteSnapshot
 * @property {string} id Snapshot id
 * @property {number} createdAt Snapshot timestamp (epoch ms)
 * @property {string} title
 * @property {string} body
 */

// PUBLIC_INTERFACE
export function historyStorageKey(noteId) {
  /** Returns the localStorage key for a note's history. */
  return `${HISTORY_KEY_PREFIX}${String(noteId || "")}`;
}

function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readSnapshots(noteId) {
  const key = historyStorageKey(noteId);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = safeParseJson(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s) => s && typeof s === "object")
      .map((s) => ({
        id: typeof s.id === "string" ? s.id : "",
        createdAt: Number.isFinite(s.createdAt) ? s.createdAt : 0,
        title: typeof s.title === "string" ? s.title : "",
        body: typeof s.body === "string" ? s.body : "",
      }))
      .filter((s) => s.id && s.createdAt)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

function writeSnapshots(noteId, snapshots) {
  const key = historyStorageKey(noteId);
  localStorage.setItem(key, JSON.stringify(Array.isArray(snapshots) ? snapshots : []));
}

function createSnapshotId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizedTextForCompare(text) {
  // Normalize trailing whitespace to reduce "false changes" from textarea quirks
  return String(text || "").replace(/\s+$/g, "");
}

// PUBLIC_INTERFACE
export function getNoteSnapshots(noteId) {
  /** Return snapshots for a note (newest first). */
  if (!noteId) return [];
  return readSnapshots(noteId);
}

// PUBLIC_INTERFACE
export function addNoteSnapshot(note, opts = {}) {
  /**
   * Add a snapshot for a note.
   *
   * Dedupes against the latest snapshot (same title+body after normalization).
   *
   * @param {{id:string,title?:string,body?:string}} note
   * @param {{maxSnapshots?: number}} opts
   * @returns {NoteSnapshot|null} the created snapshot, or null if skipped
   */
  const id = String(note?.id || "");
  if (!id) return null;

  const title = String(note?.title || "");
  const body = String(note?.body || "");

  const maxSnapshots = Number.isFinite(opts.maxSnapshots) ? opts.maxSnapshots : DEFAULT_MAX_SNAPSHOTS;

  const existing = readSnapshots(id);
  const latest = existing[0];

  const aTitle = normalizedTextForCompare(title);
  const aBody = normalizedTextForCompare(body);

  if (latest) {
    const bTitle = normalizedTextForCompare(latest.title);
    const bBody = normalizedTextForCompare(latest.body);
    if (aTitle === bTitle && aBody === bBody) return null;
  }

  const snapshot = {
    id: createSnapshotId(),
    createdAt: Date.now(),
    title,
    body,
  };

  const next = [snapshot, ...existing].slice(0, Math.max(1, maxSnapshots));
  writeSnapshots(id, next);
  return snapshot;
}

// PUBLIC_INTERFACE
export function clearNoteSnapshots(noteId) {
  /** Remove all snapshots for a note. */
  if (!noteId) return;
  try {
    localStorage.removeItem(historyStorageKey(noteId));
  } catch {
    // ignore
  }
}

// PUBLIC_INTERFACE
export function deleteNoteSnapshot(noteId, snapshotId) {
  /** Delete a single snapshot by id. */
  if (!noteId || !snapshotId) return;
  const existing = readSnapshots(noteId);
  const next = existing.filter((s) => s.id !== snapshotId);
  writeSnapshots(noteId, next);
}
