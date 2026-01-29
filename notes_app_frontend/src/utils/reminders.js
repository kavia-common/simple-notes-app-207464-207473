/**
 * Local reminders (in-browser) via Notifications API.
 *
 * Implementation notes:
 * - Uses setTimeout scheduling. This means reminders only fire while the page/tab is open.
 * - Uses localStorage persistence for reminder metadata so reminders can be re-scheduled on reload.
 * - Does NOT require any backend/service worker.
 */

const REMINDERS_STORAGE_KEY = "retro_notes_reminders_v1";

/** @type {Map<string, number>} noteId -> timeoutId */
const scheduledTimeouts = new Map();

/**
 * @typedef {Object} NoteReminder
 * @property {string} noteId
 * @property {number} remindAt Epoch millis when notification should fire
 * @property {string=} title Snapshot title at schedule time
 * @property {string=} preview Snapshot preview at schedule time
 */

/**
 * Read reminders map from storage.
 * @returns {Record<string, NoteReminder>}
 */
function readReminderMap() {
  try {
    const raw = localStorage.getItem(REMINDERS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

/**
 * Persist reminders map to storage.
 * @param {Record<string, NoteReminder>} map
 */
function writeReminderMap(map) {
  localStorage.setItem(REMINDERS_STORAGE_KEY, JSON.stringify(map));
}

// PUBLIC_INTERFACE
export function notificationsSupported() {
  /** Returns true if the Notifications API is available in this browser. */
  return typeof window !== "undefined" && "Notification" in window;
}

// PUBLIC_INTERFACE
export function getNotificationPermission() {
  /** Return current Notification.permission value, or "unsupported". */
  if (!notificationsSupported()) return "unsupported";
  return Notification.permission;
}

// PUBLIC_INTERFACE
export async function requestNotificationPermission() {
  /** Request notification permission from the user (if supported). */
  if (!notificationsSupported()) return "unsupported";

  try {
    const res = await Notification.requestPermission();
    return res;
  } catch {
    // Some older browsers throw rather than returning a promise
    try {
      // eslint-disable-next-line no-undef
      return await new Promise((resolve) =>
        Notification.requestPermission((p) => resolve(p))
      );
    } catch {
      return Notification.permission;
    }
  }
}

function safePreview(body) {
  return String(body || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function showReminderNotification({ noteId, title, preview }) {
  if (!notificationsSupported()) return;
  if (Notification.permission !== "granted") return;

  const n = new Notification(title || "Note reminder", {
    body: preview || "Open Retro Notes to view.",
    tag: `retro-notes-reminder:${noteId}`, // helps collapse duplicates in some browsers
    renotify: true,
  });

  // Best-effort focus on click.
  n.onclick = () => {
    try {
      window.focus();
    } catch {
      // ignore
    }
    n.close();
  };
}

function internalCancelTimeout(noteId) {
  const tid = scheduledTimeouts.get(noteId);
  if (typeof tid === "number") {
    clearTimeout(tid);
    scheduledTimeouts.delete(noteId);
  }
}

function internalScheduleTimeout(reminder) {
  internalCancelTimeout(reminder.noteId);

  const delay = Math.max(0, reminder.remindAt - Date.now());

  const tid = window.setTimeout(() => {
    // When firing, remove from storage first to avoid re-firing on reload.
    try {
      const map = readReminderMap();
      delete map[reminder.noteId];
      writeReminderMap(map);
    } catch {
      // ignore
    } finally {
      scheduledTimeouts.delete(reminder.noteId);
    }

    showReminderNotification(reminder);
  }, delay);

  scheduledTimeouts.set(reminder.noteId, tid);
}

// PUBLIC_INTERFACE
export function listReminders() {
  /** Return reminders as an array (best-effort). */
  const map = readReminderMap();
  return Object.values(map)
    .filter((r) => r && typeof r.noteId === "string" && Number.isFinite(r.remindAt))
    .sort((a, b) => a.remindAt - b.remindAt);
}

// PUBLIC_INTERFACE
export function getReminderForNote(noteId) {
  /** Get reminder info for a note, or null. */
  const map = readReminderMap();
  const r = map[String(noteId)];
  if (!r || !Number.isFinite(r.remindAt)) return null;
  return r;
}

// PUBLIC_INTERFACE
export function cancelReminder(noteId) {
  /** Cancel a reminder for a note (clears timeout + removes persistence). */
  const id = String(noteId);
  internalCancelTimeout(id);

  const map = readReminderMap();
  if (map[id]) {
    delete map[id];
    writeReminderMap(map);
  }
}

// PUBLIC_INTERFACE
export function scheduleReminder(note, remindAt) {
  /**
   * Schedule a reminder for a note at a specific time.
   * Persists metadata and schedules a timeout (fires only while app is open).
   *
   * @param {{id:string,title?:string,body?:string}} note
   * @param {number} remindAt epoch millis
   */
  const id = String(note?.id || "");
  if (!id) throw new Error("scheduleReminder requires note.id");
  if (!Number.isFinite(remindAt)) throw new Error("scheduleReminder requires remindAt millis");

  const reminder = {
    noteId: id,
    remindAt,
    title: String(note?.title || "Untitled"),
    preview: safePreview(note?.body),
  };

  const map = readReminderMap();
  map[id] = reminder;
  writeReminderMap(map);

  internalScheduleTimeout(reminder);
}

// PUBLIC_INTERFACE
export function rescheduleAllReminders({ existingNoteIds } = {}) {
  /**
   * Reschedule all reminders from storage.
   * If existingNoteIds is provided, reminders for missing notes are removed.
   *
   * @param {{existingNoteIds?: Set<string>}} opts
   */
  // Clear existing timeouts.
  for (const noteId of scheduledTimeouts.keys()) {
    internalCancelTimeout(noteId);
  }

  const map = readReminderMap();

  // Drop invalid or orphaned reminders.
  let mutated = false;
  for (const [noteId, r] of Object.entries(map)) {
    if (!r || typeof r !== "object" || !Number.isFinite(r.remindAt)) {
      delete map[noteId];
      mutated = true;
      continue;
    }
    if (existingNoteIds && !existingNoteIds.has(noteId)) {
      delete map[noteId];
      mutated = true;
      continue;
    }
    // If already in the past, drop it (avoid immediate burst on reload).
    if (r.remindAt <= Date.now()) {
      delete map[noteId];
      mutated = true;
      continue;
    }
  }

  if (mutated) {
    try {
      writeReminderMap(map);
    } catch {
      // ignore
    }
  }

  // Only schedule if permission is granted; otherwise keep persisted so user can grant later.
  if (!notificationsSupported() || Notification.permission !== "granted") return;

  for (const r of Object.values(map)) {
    internalScheduleTimeout(r);
  }
}
