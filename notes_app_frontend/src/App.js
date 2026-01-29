import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import DOMPurify from "dompurify";
import CommandPalette from "./components/CommandPalette";
import TagManager from "./components/TagManager";
import {
  cancelReminder,
  getNotificationPermission,
  getReminderForNote,
  notificationsSupported,
  requestNotificationPermission,
  rescheduleAllReminders,
  scheduleReminder,
} from "./utils/reminders";
import {
  addNoteSnapshot,
  getNoteSnapshots,
  clearNoteSnapshots,
} from "./utils/versionHistory";
import {
  canUseEncryptedStorage,
  createEncryptedVaultFromLegacy,
  hasEncryptedPayload,
  hasLegacyUnencryptedNotes,
  saveEncryptedNotes,
  unlockEncryptedNotes,
} from "./utils/encryptedStorage";
import "./App.css";

/**
 * Small helper to generate reasonably-unique ids without adding dependencies.
 * Good enough for local-only notes.
 */
function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Legacy keys kept for backwards-compatibility migration only.
// New encrypted storage uses utils/encryptedStorage.js
const STORAGE_KEY = "retro_notes_v1";
const TRASH_STORAGE_KEY = "retro_notes_trash_v1";

const SORT_MODE_KEY = "retro_notes_sort_mode_v1";
const EXPORT_SCHEMA_VERSION = 2;

const THEME_KEY = "retro_notes_theme_v1";

/** @typedef {"retro"|"light"} Theme */

/**
 * @typedef {Object} Note
 * @property {string} id
 * @property {string} title
 * @property {string} body
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {boolean} pinned
 * @property {string[]} tags
 * @property {number=} deletedAt
 * @property {number=} reminderAt
 */

/**
 * Sort notes such that:
 * 1) pinned notes come first
 * 2) within the pinned/unpinned group, most recently updated comes first
 */
function sortNotesPinnedFirst(a, b) {
  const ap = Boolean(a.pinned);
  const bp = Boolean(b.pinned);
  if (ap !== bp) return ap ? -1 : 1;
  return (b.updatedAt || 0) - (a.updatedAt || 0);
}

/**
 * Available sort modes for the notes list.
 * @typedef {"updated_desc"|"created_desc"|"title_asc"|"title_desc"} SortMode
 */
const SORT_MODES = [
  { value: "updated_desc", label: "Last edited" },
  { value: "created_desc", label: "Created date" },
  { value: "title_asc", label: "Title (A→Z)" },
  { value: "title_desc", label: "Title (Z→A)" },
];

/**
 * Compare two notes by a given sort mode (does NOT account for pinning).
 * Pinning-first ordering is applied separately to preserve the existing behavior.
 */
function compareNotesBySortMode(a, b, sortMode) {
  const mode = sortMode || "updated_desc";

  if (mode === "created_desc") return (b.createdAt || 0) - (a.createdAt || 0);
  if (mode === "title_asc")
    return String(a.title || "").localeCompare(String(b.title || ""), undefined, {
      sensitivity: "base",
    });
  if (mode === "title_desc")
    return String(b.title || "").localeCompare(String(a.title || ""), undefined, {
      sensitivity: "base",
    });

  // Default: updated_desc
  return (b.updatedAt || 0) - (a.updatedAt || 0);
}

/**
 * Pinned-first comparator with a configurable secondary sort.
 */
function sortNotesPinnedFirstBy(sortMode) {
  return (a, b) => {
    const ap = Boolean(a.pinned);
    const bp = Boolean(b.pinned);
    if (ap !== bp) return ap ? -1 : 1;
    return compareNotesBySortMode(a, b, sortMode);
  };
}

/**
 * Normalize a tag string:
 * - trim
 * - collapse inner whitespace
 * - lower-case for consistent matching
 */
function normalizeTag(raw) {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Convert a free-form string into a list of tags.
 * Supports comma-separated input, and ignores empties.
 */
function parseTagsInput(raw) {
  const parts = String(raw || "")
    .split(",")
    .map((p) => normalizeTag(p))
    .filter(Boolean);

  // de-dupe while preserving order
  return Array.from(new Set(parts));
}

/**
 * Normalize/validate a raw object into a Note, or return null if unusable.
 * This is used for both localStorage load and JSON import.
 */
function normalizeNote(raw) {
  if (!raw || typeof raw !== "object") return null;

  // id is required; generate one if missing to avoid import failures.
  const id =
    typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : createId();

  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();
  const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt;

  const tags = Array.isArray(raw.tags)
    ? Array.from(new Set(raw.tags.map((t) => normalizeTag(t)).filter(Boolean)))
    : [];

  // Soft delete timestamp (if present).
  const deletedAt = Number.isFinite(raw.deletedAt) ? raw.deletedAt : undefined;

  // Reminder timestamp (if present).
  const reminderAt = Number.isFinite(raw.reminderAt) ? raw.reminderAt : undefined;

  return {
    id,
    title: typeof raw.title === "string" ? raw.title : "",
    body: typeof raw.body === "string" ? raw.body : "",
    createdAt,
    updatedAt,
    pinned: Boolean(raw.pinned),
    tags,
    deletedAt,
    reminderAt,
  };
}

/**
 * Accept export payload formats:
 * 1) Array<Note>
 * 2) { schemaVersion, exportedAt, notes: Array<Note> }
 * 3) { schemaVersion, exportedAt, activeNotes: Array<Note>, trashedNotes: Array<Note> }
 */
function extractNotesFromImportPayload(payload) {
  if (Array.isArray(payload)) return { activeNotes: payload, trashedNotes: [] };
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.notes)) {
      return { activeNotes: payload.notes, trashedNotes: [] };
    }
    if (Array.isArray(payload.activeNotes) || Array.isArray(payload.trashedNotes)) {
      return {
        activeNotes: Array.isArray(payload.activeNotes) ? payload.activeNotes : [],
        trashedNotes: Array.isArray(payload.trashedNotes) ? payload.trashedNotes : [],
      };
    }
  }
  return null;
}

function makeExportFileName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate()
  )}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `retro-notes_${stamp}.json`;
}

/** @typedef {"notes"|"trash"} AppView */

/**
 * Determine whether a global shortcut should fire given the key event.
 * We avoid hijacking common typing/editing interactions in form fields.
 */
function shouldIgnoreGlobalShortcut(e) {
  // If the user is composing with an IME (Japanese/Chinese/etc.), don't interfere.
  if (e.isComposing) return true;

  const t = e.target;
  if (!t || !(t instanceof HTMLElement)) return false;

  // Contenteditable or explicit opt-out:
  if (t.isContentEditable) return true;
  if (t.closest("[data-hotkeys='off']")) return true;

  const tag = (t.tagName || "").toLowerCase();

  // If focus is in any text input control, ignore most shortcuts.
  // We still allow Escape via existing per-input handlers.
  if (tag === "input" || tag === "textarea" || tag === "select") return true;

  return false;
}

/**
 * Safely read theme from localStorage.
 * Defaults to "retro" (the current look) for backwards compatibility.
 */
function readStoredTheme() {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw === "light" || raw === "retro" ? raw : "retro";
  } catch {
    return "retro";
  }
}

/**
 * Security hardening helpers for Markdown preview.
 *
 * Note: react-markdown does NOT render raw HTML by default (so <script> won't execute),
 * but we add defense-in-depth to ensure:
 * - links can't use "javascript:" or other dangerous protocols
 * - if raw HTML is ever enabled in the future, we have a safe rendering path ready
 */
function isSafeUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return false;

  // Allow hash links and relative paths.
  if (
    raw.startsWith("#") ||
    raw.startsWith("/") ||
    raw.startsWith("./") ||
    raw.startsWith("../")
  ) {
    return true;
  }

  // Allow standard http(s) and mailto/tel.
  try {
    const parsed = new URL(raw);
    const protocol = parsed.protocol.toLowerCase();
    return (
      protocol === "http:" ||
      protocol === "https:" ||
      protocol === "mailto:" ||
      protocol === "tel:"
    );
  } catch {
    // If URL constructor fails, treat as unsafe.
    return false;
  }
}

function sanitizeHtml(html) {
  // DOMPurify defaults are already quite strict; we explicitly forbid common scriptable nodes/attrs.
  // We also disallow "style" to avoid CSS injection shenanigans.
  return DOMPurify.sanitize(String(html || ""), {
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "link", "meta"],
    FORBID_ATTR: ["style", "onerror", "onload", "onclick", "onmouseover"],
  });
}

function safeTrimEnd(text) {
  return String(text || "").trimEnd();
}

function normalizeForCompare(text) {
  // Treat trailing whitespace as not meaningful for change detection.
  return safeTrimEnd(text);
}

// PUBLIC_INTERFACE
function App() {
  /** @type {[Theme, Function]} */
  const [theme, setTheme] = useState(() => readStoredTheme());

  /** @type {[Note[], Function]} */
  const [notes, setNotes] = useState([]);
  /** @type {[Note[], Function]} */
  const [trashedNotes, setTrashedNotes] = useState([]);

  const [selectedId, setSelectedId] = useState(null);
  /** @type {[AppView, Function]} */
  const [view, setView] = useState("notes");

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [query, setQuery] = useState("");

  /** @typedef {"edit"|"preview"} EditorMode */
  /** @type {[EditorMode, Function]} */
  const [editorMode, setEditorMode] = useState("edit");

  /** @type {[SortMode, Function]} */
  const [sortMode, setSortMode] = useState("updated_desc");

  // Tag filter: which tag is currently selected in the list filter.
  const [activeTag, setActiveTag] = useState("");

  // Tag input for the selected note.
  const [tagDraft, setTagDraft] = useState("");

  const [error, setError] = useState("");

  // Encryption / lock state
  const encryptionSupported = useMemo(() => canUseEncryptedStorage(), []);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [passphraseDraft, setPassphraseDraft] = useState("");
  const [unlockError, setUnlockError] = useState("");
  const [unlockBusy, setUnlockBusy] = useState(false);

  // Notifications permission state (for UI display).
  const [notifPermission, setNotifPermission] = useState(() =>
    getNotificationPermission()
  );

  // Autosave indicator state.
  /** @typedef {"saved"|"unsaved"|"saving"|"error"} AutosaveStatus */
  /** @type {[AutosaveStatus, Function]} */
  const [autosaveStatus, setAutosaveStatus] = useState("saved");
  const [autosaveMessage, setAutosaveMessage] = useState("");
  const [lastAutosavedAt, setLastAutosavedAt] = useState(0);

  // Version history UI state (per selected note).
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [historyItems, setHistoryItems] = useState([]);

  // Used to debounce autosave and avoid applying stale timers after switching notes.
  const autosaveTimerRef = useRef(null);
  const autosaveTokenRef = useRef(0);

  // Used to detect "unsaved changes" against the currently persisted note.
  const lastPersistedRef = useRef({ noteId: "", title: "", body: "" });

  const titleInputRef = useRef(null);
  const importInputRef = useRef(null);

  // Keyboard shortcut focus targets.
  const searchInputRef = useRef(null);

  // Command palette UI state.
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);

  // Tag manager UI state.
  const [isTagManagerOpen, setIsTagManagerOpen] = useState(false);

  // PUBLIC_INTERFACE
  function openCommandPalette() {
    /** Open the command palette modal. */
    setIsCommandPaletteOpen(true);
  }

  // PUBLIC_INTERFACE
  function closeCommandPalette() {
    /** Close the command palette modal. */
    setIsCommandPaletteOpen(false);
  }

  // PUBLIC_INTERFACE
  function openTagManager() {
    /** Open the tag manager modal. */
    setIsTagManagerOpen(true);
  }

  // PUBLIC_INTERFACE
  function closeTagManager() {
    /** Close the tag manager modal. */
    setIsTagManagerOpen(false);
  }

  // PUBLIC_INTERFACE
  function focusSearch() {
    /** Focus and select the search input (left sidebar). */
    setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select?.();
    }, 0);
  }

  // PUBLIC_INTERFACE
  async function lockNow() {
    /** Immediately lock the app (keeps encrypted payload in localStorage). */
    // Best-effort: persist any in-memory changes before locking.
    try {
      if (passphrase) {
        await saveEncryptedNotes(passphrase, { activeNotes: notes, trashedNotes });
      }
    } catch (e) {
      console.warn("Failed to save before lock:", e);
    }

    // Clear sensitive state from memory.
    setIsUnlocked(false);
    setPassphrase("");
    setPassphraseDraft("");
    setUnlockError("");
    setQuery("");
    setActiveTag("");
    setSelectedId(null);
    setTitle("");
    setBody("");
    setNotes([]);
    setTrashedNotes([]);
    setIsHistoryOpen(false);
    setHistoryItems([]);
    setView("notes");
  }

  async function doUnlock(phrase) {
    setUnlockBusy(true);
    setUnlockError("");
    setError("");

    try {
      const existsEnc = hasEncryptedPayload();
      const hasLegacy = hasLegacyUnencryptedNotes();

      let payload;
      if (!existsEnc && hasLegacy) {
        // Migration path: create encrypted vault from legacy plaintext.
        payload = await createEncryptedVaultFromLegacy(phrase);
      } else {
        payload = await unlockEncryptedNotes(phrase);
      }

      const normalizedActive = (payload.activeNotes || [])
        .map((n) => normalizeNote(n))
        .filter(Boolean)
        .map((n) => ({ ...n, deletedAt: undefined }))
        .sort(sortNotesPinnedFirst);

      const normalizedTrash = (payload.trashedNotes || [])
        .map((n) => normalizeNote(n))
        .filter(Boolean)
        .map((n) => ({
          ...n,
          deletedAt: Number.isFinite(n.deletedAt) ? n.deletedAt : Date.now(),
          pinned: false,
        }))
        .sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));

      setNotes(normalizedActive);
      setTrashedNotes(normalizedTrash);

      setSelectedId(normalizedActive[0]?.id || null);
      setView("notes");

      setPassphrase(phrase);
      setPassphraseDraft("");
      setIsUnlocked(true);

      setAutosaveStatus("saved");
      setAutosaveMessage("All changes saved");
      setLastAutosavedAt(0);
    } catch (e) {
      console.error("Unlock failed:", e);
      setUnlockError("Incorrect passphrase or corrupted vault.");
    } finally {
      setUnlockBusy(false);
    }
  }

  // Persist theme preference.
  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {
      // Non-fatal: theme preference just won't persist.
      console.warn("Failed to persist theme:", e);
    }
  }, [theme]);

  // Update browser meta theme-color for nicer mobile UI.
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;

    // Keep this in sync with App theme backgrounds.
    meta.setAttribute("content", theme === "light" ? "#f8fafc" : "#070812");
  }, [theme]);

  // Load from localStorage once:
  // - sort mode is always readable
  // - notes are now encrypted; user must unlock to load them
  useEffect(() => {
    try {
      const storedSort = localStorage.getItem(SORT_MODE_KEY);
      if (storedSort && SORT_MODES.some((m) => m.value === storedSort)) {
        setSortMode(storedSort);
      }
    } catch (e) {
      console.warn("Failed to read sort mode:", e);
    }
  }, []);

  // Persist whenever active notes / trash change (encrypted).
  useEffect(() => {
    if (!isUnlocked) return;
    if (!passphrase) return;

    (async () => {
      try {
        await saveEncryptedNotes(passphrase, { activeNotes: notes, trashedNotes });
      } catch (e) {
        console.error("Failed to persist encrypted notes:", e);
        setError("Storage is full or unavailable. Changes may not persist.");
        setAutosaveStatus("error");
        setAutosaveMessage("Storage error");
      }
    })();
  }, [notes, trashedNotes, isUnlocked, passphrase]);

  // Persist sort preference.
  useEffect(() => {
    try {
      localStorage.setItem(SORT_MODE_KEY, sortMode);
    } catch (e) {
      console.error("Failed to persist sort mode:", e);
      // Non-fatal; don't show user-facing error for sort preference persistence.
    }
  }, [sortMode]);

  // Keep notification permission state in sync (user may change it in browser UI).
  useEffect(() => {
    function syncPermission() {
      setNotifPermission(getNotificationPermission());
    }

    syncPermission();

    window.addEventListener("focus", syncPermission);
    document.addEventListener("visibilitychange", syncPermission);
    return () => {
      window.removeEventListener("focus", syncPermission);
      document.removeEventListener("visibilitychange", syncPermission);
    };
  }, []);

  // Reschedule persisted reminders whenever the note set changes.
  // (Reminders are stored separately; this keeps scheduling aligned and drops orphaned reminders.)
  useEffect(() => {
    const ids = new Set([...notes, ...trashedNotes].map((n) => n.id));
    rescheduleAllReminders({ existingNoteIds: ids });
  }, [notes, trashedNotes]);

  const activeSelectedNote = useMemo(() => {
    if (!selectedId) return null;
    return notes.find((n) => n.id === selectedId) || null;
  }, [notes, selectedId]);

  const trashSelectedNote = useMemo(() => {
    if (!selectedId) return null;
    return trashedNotes.find((n) => n.id === selectedId) || null;
  }, [trashedNotes, selectedId]);

  const selectedNote = view === "trash" ? trashSelectedNote : activeSelectedNote;

  const allTags = useMemo(() => {
    // Tags are only meaningful for active notes (trash is not editable).
    const set = new Set();
    for (const n of notes) {
      for (const t of n.tags || []) set.add(normalizeTag(t));
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [notes]);

  const tagStats = useMemo(() => {
    /** Build tag -> note count, for Tag Manager. */
    const counts = new Map();
    for (const n of notes) {
      const uniq = new Set((n.tags || []).map(normalizeTag).filter(Boolean));
      for (const t of uniq) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }, [notes]);

  const visibleNotes = useMemo(() => {
    const source = view === "trash" ? trashedNotes : notes;
    const q = query.trim().toLowerCase();
    const tag = view === "trash" ? "" : normalizeTag(activeTag);

    // Preserve existing search behavior; tag filter only applies in Notes view.
    return source.filter((n) => {
      if (tag) {
        const tagMatch = (n.tags || []).map(normalizeTag).includes(tag);
        if (!tagMatch) return false;
      }

      if (!q) return true;
      const hay = `${n.title}\n${n.body}`.toLowerCase();
      return hay.includes(q);
    });
  }, [notes, trashedNotes, query, activeTag, view]);

  const visibleNotesSorted = useMemo(() => {
    if (view === "trash") {
      // In trash, sort newest deleted first (simple, expected behavior).
      return [...visibleNotes].sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
    }

    // Notes view: keep pinned-first + chosen sort mode.
    return [...visibleNotes].sort(sortNotesPinnedFirstBy(sortMode));
  }, [visibleNotes, sortMode, view]);

  const resultsCount = visibleNotesSorted.length;
  const totalCount = view === "trash" ? trashedNotes.length : notes.length;

  // Keep editor fields in sync with selected note (only for Notes view).
  useEffect(() => {
    setError("");

    // Reset to Edit mode when the selected note changes / view changes.
    // This preserves the "type and save" workflow and avoids landing in Preview unexpectedly.
    setEditorMode("edit");

    // Cancel any pending autosave when switching notes/views.
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    autosaveTokenRef.current += 1;

    if (view === "trash") {
      setTitle("");
      setBody("");
      setTagDraft("");
      setAutosaveStatus("saved");
      setAutosaveMessage("");
      setIsHistoryOpen(false);
      setHistoryItems([]);
      lastPersistedRef.current = { noteId: "", title: "", body: "" };
      return;
    }

    if (!activeSelectedNote) {
      setTitle("");
      setBody("");
      setTagDraft("");
      setAutosaveStatus("saved");
      setAutosaveMessage("");
      setIsHistoryOpen(false);
      setHistoryItems([]);
      lastPersistedRef.current = { noteId: "", title: "", body: "" };
      return;
    }

    setTitle(activeSelectedNote.title);
    setBody(activeSelectedNote.body);
    setTagDraft("");

    // Reset autosave baseline to the persisted note values.
    lastPersistedRef.current = {
      noteId: activeSelectedNote.id,
      title: normalizeForCompare(activeSelectedNote.title),
      body: normalizeForCompare(activeSelectedNote.body),
    };
    setAutosaveStatus("saved");
    setAutosaveMessage("All changes saved");

    // Load history list for UI (when opened, it will re-sync as well).
    setHistoryItems(getNoteSnapshots(activeSelectedNote.id));
  }, [activeSelectedNote, view]);

  // When switching views, ensure selectedId belongs to current list.
  useEffect(() => {
    setError("");
    setSelectedId((curr) => {
      if (!curr) {
        const first = view === "trash" ? trashedNotes[0]?.id : notes[0]?.id;
        return first || null;
      }
      const exists =
        view === "trash"
          ? trashedNotes.some((n) => n.id === curr)
          : notes.some((n) => n.id === curr);
      if (exists) return curr;

      const first = view === "trash" ? trashedNotes[0]?.id : notes[0]?.id;
      return first || null;
    });
    // In trash view, tag filter isn't applicable; keep it but it won't apply.
  }, [view, notes, trashedNotes]);

  // PUBLIC_INTERFACE
  function toggleTheme() {
    /** Toggle between Retro neon and Light theme (persisted). */
    setTheme((t) => (t === "light" ? "retro" : "light"));
  }

  // PUBLIC_INTERFACE
  function createNewNote() {
    if (!isUnlocked) return;

    setError("");
    const now = Date.now();
    const newNote = {
      id: createId(),
      title: "Untitled",
      body: "",
      createdAt: now,
      updatedAt: now,
      pinned: false,
      tags: [],
      reminderAt: undefined,
    };

    setNotes((prev) => [newNote, ...prev].sort(sortNotesPinnedFirst));
    setView("notes");
    setSelectedId(newNote.id);

    // Ensure the history starts with an initial snapshot (useful for "restore").
    try {
      addNoteSnapshot(newNote);
      setHistoryItems(getNoteSnapshots(newNote.id));
    } catch {
      // non-fatal
    }

    // Focus title input next tick.
    setTimeout(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select?.();
    }, 0);
  }

  function currentDraftIsDifferentFromPersisted() {
    if (view !== "notes") return false;
    if (!activeSelectedNote) return false;

    const baseline = lastPersistedRef.current;
    if (!baseline || baseline.noteId !== activeSelectedNote.id) return true;

    const t = normalizeForCompare(title);
    const b = normalizeForCompare(body);
    return t !== baseline.title || b !== baseline.body;
  }

  function setAutosaveUiStateForDraft() {
    const dirty = currentDraftIsDifferentFromPersisted();
    if (dirty) {
      setAutosaveStatus("unsaved");
      setAutosaveMessage("Unsaved changes");
    } else {
      setAutosaveStatus("saved");
      setAutosaveMessage("All changes saved");
    }
  }

  // Autosave: mark as dirty on draft changes and schedule a debounced save.
  useEffect(() => {
    if (!isUnlocked) return;
    if (view !== "notes") return;
    if (!activeSelectedNote) return;

    // If the draft matches persisted baseline, reflect "saved".
    setAutosaveUiStateForDraft();

    // Only schedule autosave if draft is actually different.
    const dirty = currentDraftIsDifferentFromPersisted();
    if (!dirty) return;

    const token = (autosaveTokenRef.current += 1);

    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }

    autosaveTimerRef.current = setTimeout(() => {
      // If a newer autosave has been scheduled, do nothing.
      if (token !== autosaveTokenRef.current) return;

      // Re-check dirty state at execution time.
      if (!currentDraftIsDifferentFromPersisted()) {
        setAutosaveStatus("saved");
        setAutosaveMessage("All changes saved");
        return;
      }

      // Autosave should not create empty notes (mirror manual save constraint).
      const trimmedTitle = title.trim();
      const trimmedBody = body.trimEnd();
      if (!trimmedTitle && !trimmedBody) {
        setAutosaveStatus("unsaved");
        setAutosaveMessage("Not saved (note is empty)");
        return;
      }

      setAutosaveStatus("saving");
      setAutosaveMessage("Saving…");

      const now = Date.now();
      const nextTitle = trimmedTitle || "Untitled";

      try {
        // 1) Update note in state (persisted via encrypted persistence effect).
        setNotes((prev) => {
          const updated = prev.map((n) =>
            n.id === activeSelectedNote.id
              ? {
                  ...n,
                  title: nextTitle,
                  body: trimmedBody,
                  updatedAt: now,
                }
              : n
          );
          updated.sort(sortNotesPinnedFirst);
          return updated;
        });

        // 2) Add snapshot (version history) on autosave boundary.
        try {
          addNoteSnapshot({ id: activeSelectedNote.id, title: nextTitle, body: trimmedBody });
          if (isHistoryOpen) {
            setHistoryItems(getNoteSnapshots(activeSelectedNote.id));
          }
        } catch {
          // ignore snapshot errors
        }

        // 3) Update baseline for dirty detection.
        lastPersistedRef.current = {
          noteId: activeSelectedNote.id,
          title: normalizeForCompare(nextTitle),
          body: normalizeForCompare(trimmedBody),
        };

        setAutosaveStatus("saved");
        setAutosaveMessage("Saved");
        setLastAutosavedAt(now);
      } catch (e) {
        console.error("Autosave failed:", e);
        setAutosaveStatus("error");
        setAutosaveMessage("Autosave failed");
      }
    }, 900);

    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
    // Intentionally depends on draft fields + selected note identity.
  }, [title, body, view, activeSelectedNote, isHistoryOpen, isUnlocked]); // eslint-disable-line react-hooks/exhaustive-deps

  // PUBLIC_INTERFACE
  function saveSelectedNote() {
    setError("");

    if (!isUnlocked) {
      setError("Unlock to edit notes.");
      return;
    }

    if (view !== "notes") {
      setError("Trash items can't be edited. Restore the note first.");
      return;
    }

    if (!activeSelectedNote) {
      setError("No note selected.");
      return;
    }

    const trimmedTitle = title.trim();
    const trimmedBody = body.trimEnd(); // keep intentional leading spaces but normalize trailing

    if (!trimmedTitle && !trimmedBody) {
      setError("A note can't be completely empty. Add a title or some text.");
      return;
    }

    const nextTitle = trimmedTitle || "Untitled";
    const now = Date.now();

    setNotes((prev) => {
      const updated = prev.map((n) =>
        n.id === activeSelectedNote.id
          ? {
              ...n,
              title: nextTitle,
              body: trimmedBody,
              updatedAt: now,
            }
          : n
      );
      updated.sort(sortNotesPinnedFirst);
      return updated;
    });

    // Keep version history aligned with explicit saves too.
    try {
      addNoteSnapshot({ id: activeSelectedNote.id, title: nextTitle, body: trimmedBody });
      setHistoryItems(getNoteSnapshots(activeSelectedNote.id));
    } catch {
      // ignore
    }

    lastPersistedRef.current = {
      noteId: activeSelectedNote.id,
      title: normalizeForCompare(nextTitle),
      body: normalizeForCompare(trimmedBody),
    };
    setAutosaveStatus("saved");
    setAutosaveMessage("Saved");
    setLastAutosavedAt(now);
  }

  // PUBLIC_INTERFACE
  function moveSelectedNoteToTrash() {
    /** Soft delete: remove from active list and move into Trash. */
    setError("");
    if (!isUnlocked) {
      setError("Unlock to delete notes.");
      return;
    }
    if (view !== "notes") {
      setError("Switch to Notes to delete notes.");
      return;
    }
    if (!activeSelectedNote) {
      setError("No note selected.");
      return;
    }

    // Reminders should not fire for trashed notes.
    cancelReminder(activeSelectedNote.id);

    const ok = window.confirm(
      `Move "${activeSelectedNote.title || "Untitled"}" to Trash?`
    );
    if (!ok) return;

    const deletedAt = Date.now();

    setNotes((prev) => {
      const next = prev.filter((n) => n.id !== activeSelectedNote.id);
      // pick next selection in notes view
      setSelectedId(next.length ? next[0].id : null);
      return next;
    });

    setTrashedNotes((prev) => {
      const trashedCopy = {
        ...activeSelectedNote,
        pinned: false,
        deletedAt,
        reminderAt: undefined,
      };
      // Avoid duplicates if somehow already in trash
      const filtered = prev.filter((n) => n.id !== trashedCopy.id);
      return [trashedCopy, ...filtered].sort(
        (a, b) => (b.deletedAt || 0) - (a.deletedAt || 0)
      );
    });

    // Close history panel when note is no longer editable.
    setIsHistoryOpen(false);
  }

  // PUBLIC_INTERFACE
  function restoreSelectedNoteFromTrash() {
    /** Restore: move from Trash back to Notes. */
    setError("");
    if (!isUnlocked) {
      setError("Unlock to restore notes.");
      return;
    }
    if (view !== "trash") {
      setError("Switch to Trash to restore notes.");
      return;
    }
    if (!trashSelectedNote) {
      setError("No trashed note selected.");
      return;
    }

    setTrashedNotes((prev) => {
      const next = prev.filter((n) => n.id !== trashSelectedNote.id);
      // pick next selection in trash view
      setSelectedId(next.length ? next[0].id : null);
      return next;
    });

    setNotes((prev) => {
      const restored = {
        ...trashSelectedNote,
        deletedAt: undefined,
        pinned: false, // restored notes come back unpinned to avoid surprising "jump to top"
        updatedAt: Date.now(), // make restore visible in "Last edited" sort
      };
      const filtered = prev.filter((n) => n.id !== restored.id);
      const merged = [restored, ...filtered].sort(sortNotesPinnedFirst);
      return merged;
    });
  }

  // PUBLIC_INTERFACE
  function permanentlyDeleteSelectedTrashNote() {
    /** Permanent delete: remove from Trash forever. */
    setError("");
    if (!isUnlocked) {
      setError("Unlock to delete notes.");
      return;
    }
    if (view !== "trash") {
      setError("Switch to Trash to permanently delete notes.");
      return;
    }
    if (!trashSelectedNote) {
      setError("No trashed note selected.");
      return;
    }

    cancelReminder(trashSelectedNote.id);

    const ok = window.confirm(
      `Permanently delete "${trashSelectedNote.title || "Untitled"}"? This cannot be undone.`
    );
    if (!ok) return;

    setTrashedNotes((prev) => {
      const next = prev.filter((n) => n.id !== trashSelectedNote.id);
      setSelectedId(next.length ? next[0].id : null);
      return next;
    });
  }

  // PUBLIC_INTERFACE
  function emptyTrash() {
    /** Permanently delete ALL notes from Trash. */
    setError("");
    if (!isUnlocked) {
      setError("Unlock to empty Trash.");
      return;
    }
    if (trashedNotes.length === 0) return;

    const ok = window.confirm(
      `Empty Trash (${trashedNotes.length} item${trashedNotes.length === 1 ? "" : "s"})? This cannot be undone.`
    );
    if (!ok) return;

    setTrashedNotes([]);
    setSelectedId(null);
  }

  // PUBLIC_INTERFACE
  async function ensureNotificationPermission() {
    /** Request notification permission if needed, and sync state. */
    setError("");

    if (!notificationsSupported()) {
      setError("Notifications are not supported in this browser.");
      return false;
    }

    const current = getNotificationPermission();
    if (current === "granted") return true;

    const res = await requestNotificationPermission();
    setNotifPermission(res);

    if (res !== "granted") {
      setError("Notifications permission was not granted. Reminder not set.");
      return false;
    }
    return true;
  }

  // PUBLIC_INTERFACE
  function setReminderForSelectedNote(remindAtMs) {
    /** Schedule a reminder for the selected note (Notes view only). */
    setError("");

    if (!isUnlocked) {
      setError("Unlock to set reminders.");
      return;
    }

    if (view !== "notes") {
      setError("Set reminders from Notes (Trash is read-only).");
      return;
    }
    if (!activeSelectedNote) {
      setError("No note selected.");
      return;
    }
    if (!Number.isFinite(remindAtMs) || remindAtMs <= Date.now()) {
      setError("Pick a future time for the reminder.");
      return;
    }

    // Keep reminder timestamp on the note for UI + export/import persistence.
    setNotes((prev) => {
      const next = prev.map((n) =>
        n.id === activeSelectedNote.id ? { ...n, reminderAt: remindAtMs } : n
      );
      next.sort(sortNotesPinnedFirst);
      return next;
    });

    // Use Notifications scheduler (will persist + schedule timeout if permission granted).
    scheduleReminder(
      { id: activeSelectedNote.id, title, body },
      remindAtMs
    );
  }

  // PUBLIC_INTERFACE
  function clearReminderForSelectedNote() {
    /** Cancel reminder for selected note. */
    setError("");

    if (!isUnlocked) return;
    if (view !== "notes") return;
    if (!activeSelectedNote) return;

    setNotes((prev) => {
      const next = prev.map((n) =>
        n.id === activeSelectedNote.id ? { ...n, reminderAt: undefined } : n
      );
      next.sort(sortNotesPinnedFirst);
      return next;
    });

    cancelReminder(activeSelectedNote.id);
  }

  // PUBLIC_INTERFACE
  function togglePin(noteId) {
    /** Toggle pin/unpin for a note. */
    if (!isUnlocked) return;
    if (view !== "notes") return;

    setNotes((prev) => {
      const next = prev.map((n) =>
        n.id === noteId ? { ...n, pinned: !Boolean(n.pinned) } : n
      );
      next.sort(sortNotesPinnedFirst);
      return next;
    });
  }

  // PUBLIC_INTERFACE
  function addTagsToSelectedNote(rawInput) {
    /** Add one or more tags to the selected note. Accepts comma-separated input. */
    setError("");

    if (!isUnlocked) {
      setError("Unlock to edit tags.");
      return;
    }

    if (view !== "notes") {
      setError("Trash items can't be tagged. Restore the note first.");
      return;
    }

    if (!activeSelectedNote) {
      setError("No note selected.");
      return;
    }

    const newTags = parseTagsInput(rawInput);
    if (newTags.length === 0) return;

    setNotes((prev) => {
      const next = prev.map((n) => {
        if (n.id !== activeSelectedNote.id) return n;
        const merged = Array.from(
          new Set([...(n.tags || []).map(normalizeTag), ...newTags])
        );
        return { ...n, tags: merged };
      });
      next.sort(sortNotesPinnedFirst);
      return next;
    });

    setTagDraft("");
  }

  // PUBLIC_INTERFACE
  function removeTagFromSelectedNote(tagToRemove) {
    /** Remove a tag from the selected note. */
    setError("");

    if (!isUnlocked) {
      setError("Unlock to edit tags.");
      return;
    }

    if (view !== "notes") {
      setError("Trash items can't be edited. Restore the note first.");
      return;
    }

    if (!activeSelectedNote) {
      setError("No note selected.");
      return;
    }

    const norm = normalizeTag(tagToRemove);
    if (!norm) return;

    setNotes((prev) => {
      const next = prev.map((n) => {
        if (n.id !== activeSelectedNote.id) return n;
        const filtered = (n.tags || []).map(normalizeTag).filter((t) => t !== norm);
        return { ...n, tags: filtered };
      });
      next.sort(sortNotesPinnedFirst);
      return next;
    });
  }

  // PUBLIC_INTERFACE
  function toggleActiveTag(tag) {
    /** Toggle tag filter on/off. */
    const norm = normalizeTag(tag);
    setActiveTag((prev) => (normalizeTag(prev) === norm ? "" : norm));
  }

  // PUBLIC_INTERFACE
  function renameTagGlobally(fromTag, toTag) {
    /** Rename a tag across all active notes. If toTag exists, this effectively merges them. */
    if (!isUnlocked) return { ok: false, message: "Unlock to edit tags." };

    const from = normalizeTag(fromTag);
    const to = normalizeTag(toTag);

    if (!from || !to) return { ok: false, message: "Both tags are required." };
    if (from === to) return { ok: false, message: "Nothing to do (same tag)." };

    const used = new Set(allTags);
    if (!used.has(from)) return { ok: false, message: `Tag "${from}" does not exist.` };

    setNotes((prev) => {
      const next = prev.map((n) => {
        const tags = (n.tags || []).map(normalizeTag).filter(Boolean);
        if (!tags.includes(from)) return n;

        const replaced = tags.map((t) => (t === from ? to : t));
        const deduped = Array.from(new Set(replaced));
        return { ...n, tags: deduped };
      });
      next.sort(sortNotesPinnedFirst);
      return next;
    });

    // Keep active filter aligned if user is filtering on the renamed tag.
    setActiveTag((prev) => (normalizeTag(prev) === from ? to : prev));

    return { ok: true };
  }

  // PUBLIC_INTERFACE
  function mergeTagsGlobally(fromTags, toTag) {
    /** Merge one or more tags into a single tag across all active notes. */
    if (!isUnlocked) return { ok: false, message: "Unlock to edit tags." };

    const to = normalizeTag(toTag);
    const fromList = Array.isArray(fromTags)
      ? Array.from(new Set(fromTags.map(normalizeTag).filter(Boolean)))
      : [];

    if (!to) return { ok: false, message: "Target tag is required." };
    if (fromList.length === 0) return { ok: false, message: "Select one or more tags to merge." };

    // If the target is included in sources, we simply treat it as "keep target" and remove others.
    const fromSet = new Set(fromList.filter((t) => t !== to));
    if (fromSet.size === 0) return { ok: false, message: "Nothing to merge into target." };

    const used = new Set(allTags);
    const missing = Array.from(fromSet).filter((t) => !used.has(t));
    if (missing.length) {
      return { ok: false, message: `Unknown tag(s): ${missing.map((t) => `"${t}"`).join(", ")}` };
    }

    setNotes((prev) => {
      const next = prev.map((n) => {
        const tags = (n.tags || []).map(normalizeTag).filter(Boolean);
        const hasAny = tags.some((t) => fromSet.has(t));
        if (!hasAny) return n;

        const filtered = tags.filter((t) => !fromSet.has(t));
        const merged = Array.from(new Set([to, ...filtered]));
        return { ...n, tags: merged };
      });
      next.sort(sortNotesPinnedFirst);
      return next;
    });

    // If activeTag is one of the merged tags, switch filter to target.
    setActiveTag((prev) => (fromSet.has(normalizeTag(prev)) ? to : prev));

    return { ok: true };
  }

  // PUBLIC_INTERFACE
  function deleteTagGlobally(tag) {
    /** Delete a tag across all active notes. */
    if (!isUnlocked) return { ok: false, message: "Unlock to edit tags." };

    const t = normalizeTag(tag);
    if (!t) return { ok: false, message: "Tag is required." };

    const used = new Set(allTags);
    if (!used.has(t)) return { ok: false, message: `Tag "${t}" does not exist.` };

    setNotes((prev) => {
      const next = prev.map((n) => {
        const tags = (n.tags || []).map(normalizeTag).filter(Boolean);
        if (!tags.includes(t)) return n;
        const filtered = tags.filter((x) => x !== t);
        return { ...n, tags: filtered };
      });
      next.sort(sortNotesPinnedFirst);
      return next;
    });

    // Clear tag filter if it was deleted.
    setActiveTag((prev) => (normalizeTag(prev) === t ? "" : prev));

    return { ok: true };
  }

  // PUBLIC_INTERFACE
  function focusTagFilter(tag) {
    /** Convenience: set tag filter to a tag and close Tag Manager. */
    const t = normalizeTag(tag);
    if (!t) return;
    setView("notes");
    setActiveTag(t);
    closeTagManager();
  }

  // PUBLIC_INTERFACE
  function exportNotesToJson() {
    /** Download notes as a JSON file (includes pinned state + tags + trash). */
    setError("");

    if (!isUnlocked) {
      setError("Unlock to export notes.");
      return;
    }

    try {
      const payload = {
        schemaVersion: EXPORT_SCHEMA_VERSION,
        exportedAt: Date.now(),
        app: "retro-notes",
        activeNotes: notes,
        trashedNotes,
      };

      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = makeExportFileName();
      document.body.appendChild(a);
      a.click();
      a.remove();

      // Delay revoke to ensure the download starts in all browsers.
      setTimeout(() => URL.revokeObjectURL(url), 250);
    } catch (e) {
      console.error("Export failed:", e);
      setError("Export failed. Please try again.");
    }
  }

  // PUBLIC_INTERFACE
  async function importNotesFromJsonFile(file) {
    /** Import notes from a JSON file. Merges by id to avoid duplicates. */
    setError("");

    if (!isUnlocked) {
      setError("Unlock to import notes.");
      return;
    }

    if (!file) return;

    try {
      if (!/\.json$/i.test(file.name) && file.type && file.type !== "application/json") {
        // Soft check; still attempt to parse in case the browser doesn't set type.
        console.warn("Import file does not look like JSON:", file.name, file.type);
      }

      const text = await file.text();
      const parsed = JSON.parse(text);

      const extracted = extractNotesFromImportPayload(parsed);
      if (!extracted) {
        setError(
          'Invalid import file format. Expected an array of notes, { notes: [...] }, or { activeNotes: [...], trashedNotes: [...] }.'
        );
        return;
      }

      const normalizedIncomingActive = (extracted.activeNotes || [])
        .map((n) => normalizeNote(n))
        .filter(Boolean)
        .map((n) => ({ ...n, deletedAt: undefined }));

      const normalizedIncomingTrash = (extracted.trashedNotes || [])
        .map((n) => normalizeNote(n))
        .filter(Boolean)
        .map((n) => ({
          ...n,
          deletedAt: Number.isFinite(n.deletedAt) ? n.deletedAt : Date.now(),
          pinned: false,
        }));

      if (normalizedIncomingActive.length === 0 && normalizedIncomingTrash.length === 0) {
        setError("Import file contained no valid notes.");
        return;
      }

      setNotes((prev) => {
        // Merge by id: incoming overrides existing for the same id.
        const byId = new Map(prev.map((n) => [n.id, n]));
        for (const n of normalizedIncomingActive) byId.set(n.id, n);
        const merged = Array.from(byId.values()).sort(sortNotesPinnedFirst);

        // If current selection belongs to notes view, keep it if possible.
        setSelectedId((curr) => {
          if (view !== "notes") return curr;
          if (curr && byId.has(curr)) return curr;
          return merged.length ? merged[0].id : null;
        });

        return merged;
      });

      setTrashedNotes((prev) => {
        const byId = new Map(prev.map((n) => [n.id, n]));
        for (const n of normalizedIncomingTrash) byId.set(n.id, n);
        const merged = Array.from(byId.values()).sort(
          (a, b) => (b.deletedAt || 0) - (a.deletedAt || 0)
        );

        setSelectedId((curr) => {
          if (view !== "trash") return curr;
          if (curr && byId.has(curr)) return curr;
          return merged.length ? merged[0].id : null;
        });

        return merged;
      });

      // Keep query/activeTag as-is to preserve current "search state".
    } catch (e) {
      console.error("Import failed:", e);
      setError("Import failed (could not read/parse JSON).");
    } finally {
      // Allow importing the same file again by resetting the input value.
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }

  /**
   * Install global keyboard shortcuts.
   *
   * Shortcuts:
   * - Ctrl/Cmd + K: Command palette
   * - Ctrl/Cmd + N: New note
   * - Ctrl/Cmd + F or / : Focus search
   * - Ctrl/Cmd + 1: Notes view
   * - Ctrl/Cmd + 2: Trash view
   * - Ctrl/Cmd + P: Toggle Markdown preview (Notes view)
   * - Delete / Backspace (when not typing): Move selected note to trash (Notes) / delete forever (Trash)
   * - R (Trash): Restore selected note
   * - Esc (global): Close command palette; otherwise clear search if not already handled by focused input.
   */
  useEffect(() => {
    function onKeyDown(e) {
      // Ignore if user is actively typing in an input/textarea/select/contenteditable.
      const ignore = shouldIgnoreGlobalShortcut(e);

      const key = String(e.key || "");
      const lower = key.toLowerCase();
      const metaOrCtrl = e.metaKey || e.ctrlKey;

      // Command palette: Ctrl/Cmd+K (common convention).
      if (metaOrCtrl && lower === "k" && !ignore) {
        e.preventDefault();
        openCommandPalette();
        return;
      }

      // Always allow browser/system shortcuts like reload, devtools, etc.
      // We only preventDefault when we actually handle something.
      if (metaOrCtrl && lower === "n" && !ignore) {
        if (!isUnlocked) return;
        e.preventDefault();
        createNewNote();
        return;
      }

      // Focus search: Ctrl/Cmd+F or "/" when not typing.
      if (((metaOrCtrl && lower === "f") || (!metaOrCtrl && lower === "/")) && !ignore) {
        if (!isUnlocked) return;
        e.preventDefault();
        focusSearch();
        return;
      }

      // Toggle views
      if (metaOrCtrl && (lower === "1" || lower === "2") && !ignore) {
        if (!isUnlocked) return;
        e.preventDefault();
        setView(lower === "1" ? "notes" : "trash");
        return;
      }

      // Toggle Markdown Edit/Preview in Notes view
      if (metaOrCtrl && lower === "p" && !ignore) {
        if (!isUnlocked) return;
        if (view !== "notes") return;
        if (!activeSelectedNote) return;
        e.preventDefault();
        setEditorMode((m) => (m === "edit" ? "preview" : "edit"));
        return;
      }

      // Tag Manager: Ctrl/Cmd+T (Notes view)
      if (metaOrCtrl && lower === "t" && !ignore) {
        if (!isUnlocked) return;
        if (view !== "notes") return;
        e.preventDefault();
        openTagManager();
        return;
      }

      // Delete shortcut when NOT typing
      if ((key === "Delete" || key === "Backspace") && !ignore) {
        if (!isUnlocked) return;

        // In Notes: delete -> move to trash
        if (view === "notes") {
          if (!activeSelectedNote) return;
          e.preventDefault();
          moveSelectedNoteToTrash();
          return;
        }

        // In Trash: delete -> permanent delete
        if (view === "trash") {
          if (!trashSelectedNote) return;
          e.preventDefault();
          permanentlyDeleteSelectedTrashNote();
          return;
        }
      }

      // Restore in trash (R)
      if (view === "trash" && lower === "r" && !ignore) {
        if (!isUnlocked) return;
        if (!trashSelectedNote) return;
        e.preventDefault();
        restoreSelectedNoteFromTrash();
        return;
      }

      // Global escape: close modals first; otherwise clear search.
      if (key === "Escape" && !ignore) {
        if (isCommandPaletteOpen) {
          e.preventDefault();
          closeCommandPalette();
          return;
        }

        if (isTagManagerOpen) {
          e.preventDefault();
          closeTagManager();
          return;
        }

        if (query.trim()) {
          e.preventDefault();
          setQuery("");
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    view,
    query,
    isCommandPaletteOpen,
    isTagManagerOpen,
    activeSelectedNote,
    trashSelectedNote,
    isUnlocked,
    // actions
    createNewNote,
    openTagManager,
    closeTagManager,
    moveSelectedNoteToTrash,
    permanentlyDeleteSelectedTrashNote,
    restoreSelectedNoteFromTrash,
  ]);

  function formatDate(ms) {
    try {
      return new Date(ms).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }

  function autosaveLabel() {
    if (view !== "notes") return "";
    if (!activeSelectedNote) return "";

    if (autosaveStatus === "saving") return "Autosave: saving…";
    if (autosaveStatus === "unsaved") return "Autosave: unsaved changes";
    if (autosaveStatus === "error") return "Autosave: error";
    if (autosaveStatus === "saved") {
      if (lastAutosavedAt) return `Autosave: saved • ${formatDate(lastAutosavedAt)}`;
      return "Autosave: saved";
    }
    return "";
  }

  const emptyState = notes.length === 0;
  const emptyTrashState = trashedNotes.length === 0;

  const commandPaletteItems = useMemo(() => {
    const hasAnyNotes = notes.length > 0 || trashedNotes.length > 0;
    const hasSelectedNote = Boolean(activeSelectedNote);
    const hasSelectedTrash = Boolean(trashSelectedNote);

    const toggleViewLabel = view === "trash" ? "Go to Notes" : "Go to Trash";
    const toggleViewHint = view === "trash" ? "Ctrl/⌘+1" : "Ctrl/⌘+2";

    const toggleMdLabel =
      editorMode === "preview" ? "Markdown: Switch to Edit" : "Markdown: Switch to Preview";

    return [
      {
        id: "lock",
        label: isUnlocked ? "Lock (encrypted notes)" : "Unlock (encrypted notes)",
        hint: "Toggle",
        keywords: ["lock", "unlock", "encryption", "secure", "vault"],
        run: () => {
          if (isUnlocked) lockNow();
          else {
            // Focus stays in unlock panel; command palette just closes.
            setTimeout(() => {
              const el = document.getElementById("vault-passphrase");
              el?.focus?.();
            }, 0);
          }
        },
      },
      {
        id: "new-note",
        label: "New note",
        hint: "Ctrl/⌘+N",
        keywords: ["create", "add", "note"],
        disabled: !isUnlocked,
        disabledReason: !isUnlocked ? "Unlock first" : "",
        run: () => createNewNote(),
      },
      {
        id: "focus-search",
        label: "Focus search",
        hint: "Ctrl/⌘+F or /",
        keywords: ["find", "filter", "search"],
        disabled: !isUnlocked,
        disabledReason: !isUnlocked ? "Unlock first" : "",
        run: () => focusSearch(),
      },
      {
        id: "toggle-view",
        label: toggleViewLabel,
        hint: toggleViewHint,
        keywords: ["notes", "trash", "view", "switch"],
        disabled: !isUnlocked,
        disabledReason: !isUnlocked ? "Unlock first" : "",
        run: () => setView(view === "trash" ? "notes" : "trash"),
      },
      {
        id: "export",
        label: "Export notes (JSON)",
        hint: "Download",
        keywords: ["backup", "download", "json"],
        disabled: !isUnlocked || !hasAnyNotes,
        disabledReason: !isUnlocked ? "Unlock first" : !hasAnyNotes ? "No notes to export" : "",
        run: () => exportNotesToJson(),
      },
      {
        id: "import",
        label: "Import notes (JSON)",
        hint: "File…",
        keywords: ["restore", "upload", "json"],
        disabled: !isUnlocked,
        disabledReason: !isUnlocked ? "Unlock first" : "",
        run: () => importInputRef.current?.click(),
      },
      {
        id: "toggle-theme",
        label: theme === "light" ? "Theme: Switch to Retro" : "Theme: Switch to Light",
        hint: "Toggle",
        keywords: ["appearance", "dark", "light", "retro"],
        run: () => toggleTheme(),
      },
      {
        id: "tag-manager",
        label: "Tags: Open Tag Manager",
        hint: "Ctrl/⌘+T",
        keywords: ["tag", "tags", "rename", "merge", "delete"],
        disabled: !isUnlocked || view !== "notes" || tagStats.length === 0,
        disabledReason: !isUnlocked
          ? "Unlock first"
          : view !== "notes"
            ? "Only available in Notes"
            : tagStats.length === 0
              ? "No tags yet"
              : "",
        run: () => openTagManager(),
      },
      {
        id: "toggle-md",
        label: toggleMdLabel,
        hint: "Ctrl/⌘+P",
        keywords: ["preview", "edit", "markdown"],
        disabled: !isUnlocked || view !== "notes" || !hasSelectedNote,
        disabledReason: !isUnlocked
          ? "Unlock first"
          : view !== "notes"
            ? "Only available in Notes"
            : !hasSelectedNote
              ? "No note selected"
              : "",
        run: () => setEditorMode((m) => (m === "edit" ? "preview" : "edit")),
      },
      {
        id: "toggle-history",
        label: isHistoryOpen ? "History: Hide versions" : "History: Show versions",
        hint: "Toggle",
        keywords: ["history", "versions", "snapshot", "restore"],
        disabled: !isUnlocked || view !== "notes" || !hasSelectedNote,
        disabledReason: !isUnlocked
          ? "Unlock first"
          : view !== "notes"
            ? "Only available in Notes"
            : !hasSelectedNote
              ? "No note selected"
              : "",
        run: () => {
          if (!isUnlocked) return;
          if (view !== "notes" || !activeSelectedNote) return;
          setIsHistoryOpen((v) => !v);
          setHistoryItems(getNoteSnapshots(activeSelectedNote.id));
        },
      },
      {
        id: "restore-latest-snapshot",
        label: "History: Restore latest snapshot",
        hint: "Restore",
        keywords: ["history", "restore", "undo"],
        disabled:
          !isUnlocked ||
          view !== "notes" ||
          !hasSelectedNote ||
          getNoteSnapshots(activeSelectedNote?.id).length === 0,
        disabledReason: !isUnlocked
          ? "Unlock first"
          : view !== "notes"
            ? "Only available in Notes"
            : !hasSelectedNote
              ? "No note selected"
              : getNoteSnapshots(activeSelectedNote?.id).length === 0
                ? "No snapshots yet"
                : "",
        run: () => {
          if (!isUnlocked) return;
          if (view !== "notes" || !activeSelectedNote) return;
          const snaps = getNoteSnapshots(activeSelectedNote.id);
          const latest = snaps[0];
          if (!latest) return;

          const ok = window.confirm("Restore the latest snapshot? Current draft will be replaced.");
          if (!ok) return;

          setTitle(latest.title);
          setBody(latest.body);
          setAutosaveStatus("unsaved");
          setAutosaveMessage("Restored snapshot (not saved yet)");
        },
      },
    ];
  }, [
    notes.length,
    trashedNotes.length,
    view,
    editorMode,
    theme,
    activeSelectedNote,
    trashSelectedNote,
    isHistoryOpen,
    tagStats.length,
    isUnlocked,
    // actions + refs
    createNewNote,
    exportNotesToJson,
    toggleTheme,
    openTagManager,
    lockNow,
    importInputRef,
  ]);

  return (
    <div className="App" data-retro="true" data-theme={theme}>
      <div className="retro-bg" aria-hidden="true" />

      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={closeCommandPalette}
        items={commandPaletteItems}
      />

      <TagManager
        isOpen={isTagManagerOpen}
        onClose={closeTagManager}
        tagStats={tagStats}
        onFocusTag={focusTagFilter}
        onRenameTag={renameTagGlobally}
        onMergeTags={mergeTagsGlobally}
        onDeleteTag={deleteTagGlobally}
      />

      <header className="retro-header">
        <div className="retro-header__left">
          <div className="retro-badge" aria-hidden="true">
            NOTES.EXE
          </div>
          <div className="retro-title-wrap">
            <h1 className="retro-title">Retro Notes</h1>
            <p className="retro-subtitle">
              Add, edit, delete — all offline.{" "}
              <span className="retro-viewhint" aria-hidden="true">
                • {isUnlocked ? (view === "trash" ? "TRASH" : "NOTES") : "LOCKED"}
              </span>
            </p>
          </div>
        </div>

        <div className="retro-header__right">
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files && e.target.files[0];
              importNotesFromJsonFile(f);
            }}
          />

          <div className="retro-theme-toggle" role="group" aria-label="Theme">
            <span className="retro-theme-toggle__label" aria-hidden="true">
              Theme
            </span>
            <button
              type="button"
              className="btn btn-small retro-theme-toggle__btn"
              onClick={toggleTheme}
              aria-pressed={theme === "light" ? "true" : "false"}
              title={theme === "light" ? "Switch to Retro neon" : "Switch to Light"}
            >
              {theme === "light" ? "Light" : "Retro"}
            </button>
          </div>

          <div className="retro-lockchip" role="group" aria-label="Encryption">
            <span className="retro-lockchip__label" aria-hidden="true">
              Vault
            </span>
            <span className={`retro-lockchip__pill ${isUnlocked ? "is-unlocked" : "is-locked"}`}>
              {isUnlocked ? "Unlocked" : "Locked"}
            </span>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                if (isUnlocked) lockNow();
                else {
                  const el = document.getElementById("vault-passphrase");
                  el?.focus?.();
                }
              }}
              title={isUnlocked ? "Lock notes" : "Unlock notes"}
            >
              {isUnlocked ? "Lock" : "Unlock"}
            </button>
          </div>

          <div className="retro-viewtoggle" role="group" aria-label="Notes view">
            <button
              type="button"
              className={`btn ${view === "notes" ? "btn-primary" : ""}`}
              onClick={() => setView("notes")}
              aria-pressed={view === "notes" ? "true" : "false"}
              title="Show notes"
              disabled={!isUnlocked}
            >
              Notes ({notes.length})
            </button>
            <button
              type="button"
              className={`btn ${view === "trash" ? "btn-primary" : ""}`}
              onClick={() => setView("trash")}
              aria-pressed={view === "trash" ? "true" : "false"}
              title="Show trash"
              disabled={!isUnlocked}
            >
              Trash ({trashedNotes.length})
            </button>
          </div>

          <button
            type="button"
            className="btn"
            onClick={() => importInputRef.current?.click()}
            title={isUnlocked ? "Import notes from JSON" : "Unlock to import"}
            disabled={!isUnlocked}
          >
            Import
          </button>

          <button
            type="button"
            className="btn"
            onClick={exportNotesToJson}
            disabled={!isUnlocked || (notes.length === 0 && trashedNotes.length === 0)}
            title={
              !isUnlocked
                ? "Unlock to export"
                : notes.length === 0 && trashedNotes.length === 0
                  ? "No notes to export"
                  : "Export notes to JSON"
            }
          >
            Export
          </button>

          <button
            type="button"
            className="btn"
            onClick={openTagManager}
            disabled={!isUnlocked || view !== "notes" || tagStats.length === 0}
            title={
              !isUnlocked
                ? "Unlock to manage tags"
                : view !== "notes"
                  ? "Tag Manager is available in Notes view"
                  : tagStats.length === 0
                    ? "No tags yet"
                    : "Manage tags (rename, merge, delete)"
            }
          >
            Tags
          </button>

          <button className="btn btn-primary" onClick={createNewNote} disabled={!isUnlocked}>
            + New note
          </button>
        </div>
      </header>

      {!encryptionSupported ? (
        <main className="retro-main">
          <section className="retro-editor" aria-label="Encryption unsupported">
            <div className="retro-editor__toolbar">
              <div className="retro-toolbar__left">
                <span className="retro-status">
                  <strong className="retro-status__strong">Encryption not supported</strong>
                </span>
              </div>
            </div>
            <div className="retro-placeholder" role="status">
              <div className="retro-placeholder__title">This browser can't encrypt notes.</div>
              <div className="retro-placeholder__body">
                Your environment does not support WebCrypto (AES-GCM). Try a modern browser.
              </div>
            </div>
          </section>
        </main>
      ) : !isUnlocked ? (
        <main className="retro-main">
          <section className="retro-editor" aria-label="Unlock encrypted notes">
            <div className="retro-editor__toolbar">
              <div className="retro-toolbar__left">
                <span className="retro-status">
                  <strong className="retro-status__strong">Locked</strong>{" "}
                  <span className="retro-status__sub">Enter passphrase to unlock your local vault.</span>
                </span>
              </div>
              <div className="retro-toolbar__right">
                <button
                  type="button"
                  className="btn"
                  onClick={() => openCommandPalette()}
                  title="Open command palette"
                >
                  Palette
                </button>
              </div>
            </div>

            {unlockError ? (
              <div className="retro-alert" role="alert">
                {unlockError}
              </div>
            ) : null}

            <div className="retro-editor__form">
              <div className="retro-field">
                <label className="retro-label" htmlFor="vault-passphrase">
                  Passphrase
                </label>
                <input
                  id="vault-passphrase"
                  type="password"
                  className="retro-input"
                  value={passphraseDraft}
                  onChange={(e) => setPassphraseDraft(e.target.value)}
                  placeholder="Type your passphrase…"
                  autoComplete="current-password"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (!passphraseDraft.trim()) return;
                      doUnlock(passphraseDraft);
                    }
                  }}
                />
                <div className="retro-hint retro-hint--small">
                  Notes are encrypted locally. If you forget the passphrase, the vault cannot be recovered.
                </div>
              </div>

              <div className="retro-lock-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => doUnlock(passphraseDraft)}
                  disabled={!passphraseDraft.trim() || unlockBusy}
                  title="Unlock notes"
                >
                  {unlockBusy ? "Unlocking…" : "Unlock"}
                </button>

                <button
                  type="button"
                  className="btn"
                  onClick={() => setPassphraseDraft("")}
                  disabled={!passphraseDraft || unlockBusy}
                  title="Clear"
                >
                  Clear
                </button>
              </div>

              <div className="retro-lock-meta">
                <div>
                  Encrypted vault: <strong>{hasEncryptedPayload() ? "present" : "not created"}</strong>
                </div>
                <div>
                  Legacy notes: <strong>{hasLegacyUnencryptedNotes() ? "found" : "none"}</strong>
                </div>
              </div>
            </div>
          </section>
        </main>
      ) : (
        <main className="retro-main">
          <aside className="retro-sidebar" aria-label="Notes list">
            <div className="retro-panel">
              <label className="retro-label" htmlFor="search">
                Search
              </label>

              <div className="retro-search">
                <input
                  ref={searchInputRef}
                  id="search"
                  className="retro-input retro-search__input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setQuery("");
                  }}
                  placeholder={view === "trash" ? "Search trash…" : "Type to filter…"}
                  aria-describedby="search-help"
                />
                <button
                  type="button"
                  className="btn retro-search__clear"
                  onClick={() => setQuery("")}
                  disabled={!query.trim()}
                  title="Clear search"
                >
                  Clear
                </button>
              </div>

              {view === "notes" ? (
                <div className="retro-sortbar" aria-label="Sorting options">
                  <label className="retro-label" htmlFor="sort">
                    Sort
                  </label>
                  <select
                    id="sort"
                    className="retro-input retro-select"
                    value={sortMode}
                    onChange={(e) => setSortMode(e.target.value)}
                    aria-label="Sort notes"
                  >
                    {SORT_MODES.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {view === "notes" ? (
                <div className="retro-filterbar" aria-label="Tag filters">
                  <div className="retro-filterbar__row">
                    <span className="retro-filterbar__label">Tags</span>
                    <button
                      type="button"
                      className="btn retro-filterbar__clear"
                      onClick={() => setActiveTag("")}
                      disabled={!normalizeTag(activeTag)}
                      title="Clear tag filter"
                    >
                      Clear tag
                    </button>
                  </div>

                  {allTags.length === 0 ? (
                    <div className="retro-filterbar__empty">No tags yet.</div>
                  ) : (
                    <div className="retro-tags" role="list">
                      {allTags.map((t) => {
                        const active = normalizeTag(activeTag) === normalizeTag(t);
                        return (
                          <button
                            key={t}
                            type="button"
                            className={`retro-tag ${active ? "is-active" : ""}`}
                            onClick={() => toggleActiveTag(t)}
                            role="listitem"
                            aria-pressed={active ? "true" : "false"}
                            title={active ? "Remove filter" : `Filter by "${t}"`}
                          >
                            #{t}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="retro-filterbar" aria-label="Trash actions">
                  <div className="retro-filterbar__row">
                    <span className="retro-filterbar__label">Trash</span>
                    <button
                      type="button"
                      className="btn btn-danger retro-filterbar__clear"
                      onClick={emptyTrash}
                      disabled={trashedNotes.length === 0}
                      title={
                        trashedNotes.length === 0
                          ? "Trash is empty"
                          : "Permanently delete everything in Trash"
                      }
                    >
                      Empty
                    </button>
                  </div>
                  <div className="retro-filterbar__empty">
                    Trash items can be restored or permanently deleted.
                  </div>
                </div>
              )}

              <div id="search-help" className="retro-search__meta" aria-live="polite">
                {query.trim() || (view === "notes" && normalizeTag(activeTag))
                  ? `Showing ${resultsCount} of ${totalCount}`
                  : `Showing all ${totalCount}`}
                {view === "notes" && normalizeTag(activeTag)
                  ? ` • TAG: ${normalizeTag(activeTag)}`
                  : ""}
              </div>
            </div>

            <div className="retro-list" role="list">
              {visibleNotesSorted.length === 0 ? (
                <div className="retro-empty" role="status">
                  No matches.
                </div>
              ) : (
                visibleNotesSorted.map((n) => {
                  const active = n.id === selectedId;
                  const preview =
                    (n.body || "")
                      .replace(/\s+/g, " ")
                      .trim()
                      .slice(0, 70) || "…";

                  const isPinned = Boolean(n.pinned);
                  const noteTags = (n.tags || []).map(normalizeTag).filter(Boolean);

                  return (
                    <div
                      key={n.id}
                      className={`retro-note-card-wrap ${active ? "is-active" : ""}`}
                      role="listitem"
                      aria-current={active ? "true" : "false"}
                    >
                      {view === "notes" ? (
                        <button
                          className="retro-note-card__pin"
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            togglePin(n.id);
                          }}
                          aria-label={isPinned ? "Unpin note" : "Pin note"}
                          title={isPinned ? "Unpin note" : "Pin note"}
                        >
                          {isPinned ? "📌" : "📍"}
                        </button>
                      ) : (
                        <div className="retro-note-card__pin" aria-hidden="true">
                          🗑
                        </div>
                      )}

                      <button
                        className={`retro-note-card ${active ? "is-active" : ""}`}
                        onClick={() => setSelectedId(n.id)}
                        type="button"
                      >
                        <div className="retro-note-card__title">{n.title || "Untitled"}</div>
                        <div className="retro-note-card__meta">
                          {view === "trash"
                            ? `Deleted: ${formatDate(n.deletedAt)}`
                            : formatDate(n.updatedAt)}
                          {view === "notes" && isPinned ? " • PINNED" : ""}
                          {view === "notes" && noteTags.length ? ` • ${noteTags.length} TAGS` : ""}
                        </div>

                        {view === "notes" && noteTags.length ? (
                          <div className="retro-note-card__tags" aria-label="Note tags">
                            {noteTags.slice(0, 3).map((t) => (
                              <span key={t} className="retro-tag-pill">
                                #{t}
                              </span>
                            ))}
                            {noteTags.length > 3 ? (
                              <span className="retro-tag-pill retro-tag-pill--more">
                                +{noteTags.length - 3}
                              </span>
                            ) : null}
                          </div>
                        ) : null}

                        <div className="retro-note-card__preview">{preview}</div>
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </aside>

          <section className="retro-editor" aria-label="Note editor">
            <div className="retro-editor__toolbar">
              <div className="retro-toolbar__left">
                <span className="retro-status">
                  {selectedNote ? (
                    <>
                      {view === "trash" ? "In Trash:" : "Editing:"}{" "}
                      <strong className="retro-status__strong">
                        {selectedNote.title || "Untitled"}
                      </strong>
                      {view === "notes" && activeSelectedNote ? (
                        <span className="retro-autosave" aria-live="polite">
                          {" "}
                          • <span className={`retro-autosave__pill is-${autosaveStatus}`}>
                            {autosaveLabel()}
                          </span>
                        </span>
                      ) : null}
                    </>
                  ) : view === "trash" ? (
                    emptyTrashState ? (
                      "Trash is empty."
                    ) : (
                      "Select a trashed note."
                    )
                  ) : emptyState ? (
                    "No notes yet."
                  ) : (
                    "Select a note to edit."
                  )}
                </span>
              </div>

              <div className="retro-toolbar__right">
                {view === "notes" ? (
                  <>
                    <button
                      className="btn"
                      onClick={() => {
                        if (!activeSelectedNote) return;
                        setIsHistoryOpen((v) => {
                          const next = !v;
                          if (next) setHistoryItems(getNoteSnapshots(activeSelectedNote.id));
                          return next;
                        });
                      }}
                      disabled={!activeSelectedNote}
                      title="Show version history"
                    >
                      History
                    </button>

                    {/* Reminders */}
                    <div className="retro-reminder" role="group" aria-label="Reminders">
                      {notificationsSupported() ? (
                        notifPermission !== "granted" ? (
                          <button
                            type="button"
                            className="btn"
                            onClick={ensureNotificationPermission}
                            title={
                              notifPermission === "denied"
                                ? "Notifications are blocked in browser settings"
                                : "Enable notifications for reminders"
                            }
                          >
                            Enable reminders
                          </button>
                        ) : null
                      ) : (
                        <button type="button" className="btn" disabled title="Not supported">
                          Reminders unsupported
                        </button>
                      )}

                      <input
                        type="datetime-local"
                        className="retro-input retro-reminder__input"
                        disabled={
                          !activeSelectedNote ||
                          !notificationsSupported() ||
                          notifPermission !== "granted"
                        }
                        value={(() => {
                          const r =
                            activeSelectedNote?.reminderAt ||
                            getReminderForNote(activeSelectedNote?.id)?.remindAt;
                          if (!r) return "";
                          try {
                            const d = new Date(r);
                            const pad = (n) => String(n).padStart(2, "0");
                            // datetime-local expects local time without seconds
                            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
                              d.getDate()
                            )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
                          } catch {
                            return "";
                          }
                        })()}
                        onChange={() => {}}
                        aria-label="Reminder time"
                        title="Pick a reminder time"
                      />

                      <button
                        type="button"
                        className="btn"
                        disabled={
                          !activeSelectedNote ||
                          !notificationsSupported() ||
                          notifPermission !== "granted"
                        }
                        onClick={() => {
                          if (!activeSelectedNote) return;
                          const input = document.querySelector(".retro-reminder__input");
                          const value = input?.value;
                          if (!value) {
                            setError("Pick a reminder time first.");
                            return;
                          }
                          const ms = new Date(value).getTime();
                          setReminderForSelectedNote(ms);
                        }}
                        title="Schedule reminder"
                      >
                        Set reminder
                      </button>

                      <button
                        type="button"
                        className="btn btn-danger"
                        disabled={!activeSelectedNote || !getReminderForNote(activeSelectedNote?.id)}
                        onClick={clearReminderForSelectedNote}
                        title="Cancel reminder"
                      >
                        Cancel
                      </button>
                    </div>

                    <button
                      className="btn"
                      onClick={() => {
                        if (!activeSelectedNote) return;
                        togglePin(activeSelectedNote.id);
                      }}
                      disabled={!activeSelectedNote}
                      title={activeSelectedNote?.pinned ? "Unpin note" : "Pin note"}
                    >
                      {activeSelectedNote?.pinned ? "Unpin" : "Pin"}
                    </button>

                    <button
                      className="btn"
                      onClick={saveSelectedNote}
                      disabled={!activeSelectedNote}
                      title="Save changes"
                    >
                      Save
                    </button>
                    <button
                      className="btn btn-danger"
                      onClick={moveSelectedNoteToTrash}
                      disabled={!activeSelectedNote}
                      title="Move note to Trash"
                    >
                      Delete
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="btn"
                      onClick={restoreSelectedNoteFromTrash}
                      disabled={!trashSelectedNote}
                      title="Restore note"
                    >
                      Restore
                    </button>
                    <button
                      className="btn btn-danger"
                      onClick={permanentlyDeleteSelectedTrashNote}
                      disabled={!trashSelectedNote}
                      title="Permanently delete note"
                    >
                      Delete forever
                    </button>
                  </>
                )}
              </div>
            </div>

            {view === "notes" && activeSelectedNote && isHistoryOpen ? (
              <div className="retro-history" aria-label="Version history">
                <div className="retro-history__head">
                  <div className="retro-history__title">Version history</div>
                  <div className="retro-history__actions">
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => {
                        setHistoryItems(getNoteSnapshots(activeSelectedNote.id));
                      }}
                      title="Refresh snapshots"
                    >
                      Refresh
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-danger"
                      onClick={() => {
                        const snaps = getNoteSnapshots(activeSelectedNote.id);
                        if (snaps.length === 0) return;
                        const ok = window.confirm(
                          `Clear all ${snaps.length} snapshots for this note? This cannot be undone.`
                        );
                        if (!ok) return;
                        clearNoteSnapshots(activeSelectedNote.id);
                        setHistoryItems([]);
                      }}
                      disabled={historyItems.length === 0}
                      title="Clear all snapshots"
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => setIsHistoryOpen(false)}
                      title="Close history"
                    >
                      Close
                    </button>
                  </div>
                </div>

                {historyItems.length === 0 ? (
                  <div className="retro-history__empty">
                    No snapshots yet. They are created automatically on autosave and manual save.
                  </div>
                ) : (
                  <div className="retro-history__list" role="list">
                    {historyItems.slice(0, 12).map((s) => {
                      const preview =
                        (s.body || "").replace(/\s+/g, " ").trim().slice(0, 90) || "…";
                      return (
                        <div key={s.id} className="retro-history__item" role="listitem">
                          <div className="retro-history__meta">
                            <div className="retro-history__when">{formatDate(s.createdAt)}</div>
                            <div className="retro-history__label">{s.title || "Untitled"}</div>
                            <div className="retro-history__preview">{preview}</div>
                          </div>
                          <div className="retro-history__btns">
                            <button
                              type="button"
                              className="btn btn-small"
                              onClick={() => {
                                const ok = window.confirm(
                                  "Restore this snapshot? Current draft will be replaced."
                                );
                                if (!ok) return;

                                setTitle(s.title);
                                setBody(s.body);
                                setAutosaveStatus("unsaved");
                                setAutosaveMessage("Restored snapshot (not saved yet)");
                              }}
                              title="Restore snapshot (replaces current draft)"
                            >
                              Restore
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}

            {error ? (
              <div className="retro-alert" role="alert">
                {error}
              </div>
            ) : null}

            {view === "notes" ? (
              activeSelectedNote ? (
                <div className="retro-editor__form">
                  <div className="retro-field">
                    <label className="retro-label" htmlFor="title">
                      Title
                    </label>
                    <input
                      id="title"
                      ref={titleInputRef}
                      className="retro-input retro-input--title"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Untitled"
                    />
                  </div>

                  <div className="retro-field">
                    <div className="retro-labelrow">
                      <label className="retro-label" htmlFor="body">
                        Note
                      </label>

                      <div className="retro-segtoggle" role="tablist" aria-label="Editor mode">
                        <button
                          type="button"
                          role="tab"
                          className={`btn btn-small ${editorMode === "edit" ? "btn-primary" : ""}`}
                          aria-selected={editorMode === "edit" ? "true" : "false"}
                          aria-pressed={editorMode === "edit" ? "true" : "false"}
                          onClick={() => setEditorMode("edit")}
                          title="Edit note"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          role="tab"
                          className={`btn btn-small ${
                            editorMode === "preview" ? "btn-primary" : ""
                          }`}
                          aria-selected={editorMode === "preview" ? "true" : "false"}
                          aria-pressed={editorMode === "preview" ? "true" : "false"}
                          onClick={() => setEditorMode("preview")}
                          title="Preview Markdown"
                        >
                          Preview
                        </button>
                      </div>
                    </div>

                    {editorMode === "edit" ? (
                      <textarea
                        id="body"
                        className="retro-textarea"
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                        placeholder="Write something…"
                        rows={12}
                      />
                    ) : (
                      <div className="retro-md-preview-wrap" aria-label="Markdown preview">
                        <div className="retro-md-preview__label">
                          Preview (Markdown)
                          <span className="retro-md-preview__hint">
                            • <kbd>Ctrl/⌘</kbd>+<kbd>P</kbd> toggle
                          </span>
                        </div>

                        <div className="retro-readonly retro-md-preview" data-hotkeys="off">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            // Security hardening:
                            // - Explicitly do NOT allow raw HTML rendering in Markdown
                            // - Drop any parsed HTML nodes if present (defense-in-depth)
                            // - Sanitize/validate URLs for links/images
                            skipHtml={true}
                            disallowedElements={[
                              "script",
                              "style",
                              "iframe",
                              "object",
                              "embed",
                              "link",
                              "meta",
                            ]}
                            unwrapDisallowed={true}
                            urlTransform={(url) => (isSafeUrl(url) ? url : "")}
                            components={{
                              a: ({ node, href, ...props }) => (
                                <a
                                  {...props}
                                  href={isSafeUrl(href) ? href : undefined}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                />
                              ),
                              img: ({ node, src, alt, ...props }) =>
                                isSafeUrl(src) ? (
                                  <img {...props} src={src} alt={alt || ""} />
                                ) : (
                                  <span />
                                ),
                              // If raw HTML ever becomes enabled later, this keeps it safe.
                              // (Not used with skipHtml=true, but kept for future-proofing.)
                              div: ({ node, ...props }) => <div {...props} />,
                            }}
                          >
                            {body && body.trim() ? body : "_Nothing to preview yet._"}
                          </ReactMarkdown>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="retro-field">
                    <label className="retro-label" htmlFor="tags">
                      Tags
                    </label>

                    <div className="retro-tags-editor" aria-label="Tags editor">
                      <div className="retro-tags-editor__chips" aria-label="Selected note tags">
                        {(activeSelectedNote.tags || []).length === 0 ? (
                          <span className="retro-tags-editor__empty">No tags assigned.</span>
                        ) : (
                          (activeSelectedNote.tags || []).map((t) => {
                            const norm = normalizeTag(t);
                            return (
                              <span key={norm} className="retro-tag-chip">
                                <span className="retro-tag-chip__text">#{norm}</span>
                                <button
                                  type="button"
                                  className="retro-tag-chip__remove"
                                  onClick={() => removeTagFromSelectedNote(norm)}
                                  aria-label={`Remove tag ${norm}`}
                                  title={`Remove ${norm}`}
                                >
                                  ×
                                </button>
                              </span>
                            );
                          })
                        )}
                      </div>

                      <form
                        className="retro-tags-editor__form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          addTagsToSelectedNote(tagDraft);
                        }}
                      >
                        <input
                          id="tags"
                          className="retro-input retro-tags-editor__input"
                          value={tagDraft}
                          onChange={(e) => setTagDraft(e.target.value)}
                          placeholder="Add tags (comma-separated)…"
                          onKeyDown={(e) => {
                            if (e.key === "Escape") setTagDraft("");
                          }}
                          aria-describedby="tags-help"
                        />
                        <button
                          type="submit"
                          className="btn"
                          disabled={!parseTagsInput(tagDraft).length}
                          title="Add tags"
                        >
                          Add
                        </button>
                      </form>

                      <div id="tags-help" className="retro-tags-editor__help">
                        Tip: Use commas. Example: <kbd>work</kbd>, <kbd>ideas</kbd>, <kbd>todo</kbd>
                      </div>
                    </div>
                  </div>

                  <div className="retro-footer">
                    <div className="retro-hint">
                      Tip: Changes autosave. Notes are encrypted in this browser (localStorage).{" "}
                      <span className="retro-hint__soft">
                        Use <kbd>Lock</kbd> to clear the passphrase from memory.
                      </span>
                    </div>
                    <div className="retro-timestamps">
                      <span>
                        Created: <strong>{formatDate(activeSelectedNote.createdAt)}</strong>
                      </span>
                      <span>
                        Updated: <strong>{formatDate(activeSelectedNote.updatedAt)}</strong>
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="retro-placeholder" role="status">
                  {emptyState ? (
                    <>
                      <div className="retro-placeholder__title">Your desktop is empty.</div>
                      <div className="retro-placeholder__body">Create your first note to begin.</div>
                      <button className="btn btn-primary" onClick={createNewNote}>
                        + New note
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="retro-placeholder__title">Select a note to edit.</div>
                      <div className="retro-placeholder__body">
                        Pick one from the list on the left, or create a new note.
                      </div>
                      <button className="btn btn-primary" onClick={createNewNote}>
                        + New note
                      </button>
                    </>
                  )}
                </div>
              )
            ) : trashSelectedNote ? (
              <div className="retro-editor__form">
                <div className="retro-field">
                  <span className="retro-label">Title</span>
                  <div className="retro-readonly">{trashSelectedNote.title || "Untitled"}</div>
                </div>

                <div className="retro-field">
                  <span className="retro-label">Note</span>
                  <div className="retro-readonly retro-readonly--body">{trashSelectedNote.body || "…"}</div>
                </div>

                <div className="retro-footer">
                  <div className="retro-hint">Trash is read-only. Restore to edit again.</div>
                  <div className="retro-timestamps">
                    <span>
                      Created: <strong>{formatDate(trashSelectedNote.createdAt)}</strong>
                    </span>
                    <span>
                      Deleted: <strong>{formatDate(trashSelectedNote.deletedAt)}</strong>
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="retro-placeholder" role="status">
                {emptyTrashState ? (
                  <>
                    <div className="retro-placeholder__title">Trash is empty.</div>
                    <div className="retro-placeholder__body">
                      Deleted notes appear here until you restore them or delete forever.
                    </div>
                    <button className="btn" onClick={() => setView("notes")}>
                      Back to Notes
                    </button>
                  </>
                ) : (
                  <>
                    <div className="retro-placeholder__title">Select a trashed note.</div>
                    <div className="retro-placeholder__body">Restore it, or delete it forever.</div>
                  </>
                )}
              </div>
            )}
          </section>
        </main>
      )}

      <footer className="retro-footerbar">
        <div className="retro-footerbar__left">
          <span className="retro-pip" aria-hidden="true" />
          <span>
            {isUnlocked ? (
              <>
                {view === "trash" ? "Trash" : "Notes"}:{" "}
                <strong>
                  {query.trim() || (view === "notes" && normalizeTag(activeTag))
                    ? `${resultsCount} / ${totalCount}`
                    : totalCount}
                </strong>
              </>
            ) : (
              <>
                Vault: <strong>Locked</strong>
              </>
            )}
          </span>
        </div>

        <div className="retro-footerbar__right">
          <span className="retro-mono">
            <kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> palette • <kbd>Lock</kbd> clears passphrase from memory
          </span>
        </div>
      </footer>
    </div>
  );
}

export default App;
