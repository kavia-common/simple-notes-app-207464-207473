import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";

/**
 * Small helper to generate reasonably-unique ids without adding dependencies.
 * Good enough for local-only notes.
 */
function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const STORAGE_KEY = "retro_notes_v1";
const TRASH_STORAGE_KEY = "retro_notes_trash_v1";
const SORT_MODE_KEY = "retro_notes_sort_mode_v1";
const EXPORT_SCHEMA_VERSION = 2;

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

  return {
    id,
    title: typeof raw.title === "string" ? raw.title : "",
    body: typeof raw.body === "string" ? raw.body : "",
    createdAt,
    updatedAt,
    pinned: Boolean(raw.pinned),
    tags,
    deletedAt,
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

// PUBLIC_INTERFACE
function App() {
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
  const titleInputRef = useRef(null);
  const importInputRef = useRef(null);

  // Keyboard shortcut focus targets.
  const searchInputRef = useRef(null);

  // Load from localStorage once.
  useEffect(() => {
    try {
      // Load sort mode (keep independent from notes payload for compatibility).
      const storedSort = localStorage.getItem(SORT_MODE_KEY);
      if (storedSort && SORT_MODES.some((m) => m.value === storedSort)) {
        setSortMode(storedSort);
      }

      // Active notes (legacy key).
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const normalized = parsed
            .map((n) => normalizeNote(n))
            .filter(Boolean)
            .map((n) => ({ ...n, deletedAt: undefined })) // ensure active notes are not "deleted"
            .sort(sortNotesPinnedFirst);

          setNotes(normalized);
          if (normalized.length > 0) {
            setSelectedId(normalized[0].id);
          }
        }
      }

      // Trashed notes (new key).
      const trashRaw = localStorage.getItem(TRASH_STORAGE_KEY);
      if (trashRaw) {
        const parsedTrash = JSON.parse(trashRaw);
        if (Array.isArray(parsedTrash)) {
          const normalizedTrash = parsedTrash
            .map((n) => normalizeNote(n))
            .filter(Boolean)
            .map((n) => ({
              ...n,
              deletedAt: Number.isFinite(n.deletedAt) ? n.deletedAt : Date.now(),
              pinned: false, // pinned doesn't matter in trash; keep it simple
            }))
            .sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));

          setTrashedNotes(normalizedTrash);
        }
      }
    } catch (e) {
      // Corrupted storage should not brick the UI.
      console.error("Failed to load notes from storage:", e);
      setError("Could not load saved notes (storage looked corrupted).");
    }
  }, []);

  // Persist whenever active notes change.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
    } catch (e) {
      console.error("Failed to persist notes:", e);
      setError("Storage is full or unavailable. Changes may not persist.");
    }
  }, [notes]);

  // Persist whenever trash changes.
  useEffect(() => {
    try {
      localStorage.setItem(TRASH_STORAGE_KEY, JSON.stringify(trashedNotes));
    } catch (e) {
      console.error("Failed to persist trash:", e);
      setError("Storage is full or unavailable. Changes may not persist.");
    }
  }, [trashedNotes]);

  // Persist sort preference.
  useEffect(() => {
    try {
      localStorage.setItem(SORT_MODE_KEY, sortMode);
    } catch (e) {
      console.error("Failed to persist sort mode:", e);
      // Non-fatal; don't show user-facing error for sort preference persistence.
    }
  }, [sortMode]);

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

    if (view === "trash") {
      setTitle("");
      setBody("");
      setTagDraft("");
      return;
    }

    if (!activeSelectedNote) {
      setTitle("");
      setBody("");
      setTagDraft("");
      return;
    }
    setTitle(activeSelectedNote.title);
    setBody(activeSelectedNote.body);
    setTagDraft("");
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
  function createNewNote() {
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
    };

    setNotes((prev) => [newNote, ...prev].sort(sortNotesPinnedFirst));
    setView("notes");
    setSelectedId(newNote.id);

    // Focus title input next tick.
    setTimeout(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select?.();
    }, 0);
  }

  // PUBLIC_INTERFACE
  function saveSelectedNote() {
    setError("");

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
  }

  // PUBLIC_INTERFACE
  function moveSelectedNoteToTrash() {
    /** Soft delete: remove from active list and move into Trash. */
    setError("");
    if (view !== "notes") {
      setError("Switch to Notes to delete notes.");
      return;
    }
    if (!activeSelectedNote) {
      setError("No note selected.");
      return;
    }

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
      };
      // Avoid duplicates if somehow already in trash
      const filtered = prev.filter((n) => n.id !== trashedCopy.id);
      return [trashedCopy, ...filtered].sort(
        (a, b) => (b.deletedAt || 0) - (a.deletedAt || 0)
      );
    });
  }

  // PUBLIC_INTERFACE
  function restoreSelectedNoteFromTrash() {
    /** Restore: move from Trash back to Notes. */
    setError("");
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
    if (view !== "trash") {
      setError("Switch to Trash to permanently delete notes.");
      return;
    }
    if (!trashSelectedNote) {
      setError("No trashed note selected.");
      return;
    }

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
    if (trashedNotes.length === 0) return;

    const ok = window.confirm(
      `Empty Trash (${trashedNotes.length} item${trashedNotes.length === 1 ? "" : "s"})? This cannot be undone.`
    );
    if (!ok) return;

    setTrashedNotes([]);
    setSelectedId(null);
  }

  // PUBLIC_INTERFACE
  function togglePin(noteId) {
    /** Toggle pin/unpin for a note. */
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
  function exportNotesToJson() {
    /** Download notes as a JSON file (includes pinned state + tags + trash). */
    setError("");

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
   * - Ctrl/Cmd + N: New note
   * - Ctrl/Cmd + K or / : Focus search
   * - Ctrl/Cmd + 1: Notes view
   * - Ctrl/Cmd + 2: Trash view
   * - Delete / Backspace (when not typing): Move selected note to trash (Notes) / delete forever (Trash)
   * - R (Trash): Restore selected note
   * - Esc (global): Clear search if not already handled by focused input; otherwise do nothing.
   */
  useEffect(() => {
    function onKeyDown(e) {
      // Ignore if user is actively typing in an input/textarea/select/contenteditable.
      const ignore = shouldIgnoreGlobalShortcut(e);

      const key = String(e.key || "");
      const lower = key.toLowerCase();
      const metaOrCtrl = e.metaKey || e.ctrlKey;

      // Always allow browser/system shortcuts like reload, devtools, etc.
      // We only preventDefault when we actually handle something.
      if (metaOrCtrl && lower === "n" && !ignore) {
        e.preventDefault();
        createNewNote();
        return;
      }

      // Focus search: Ctrl/Cmd+K is common; also support "/" when not typing.
      if (
        ((metaOrCtrl && lower === "k") || (!metaOrCtrl && lower === "/")) &&
        !ignore
      ) {
        e.preventDefault();
        setTimeout(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select?.();
        }, 0);
        return;
      }

      // Toggle views
      if (metaOrCtrl && (lower === "1" || lower === "2") && !ignore) {
        e.preventDefault();
        setView(lower === "1" ? "notes" : "trash");
        return;
      }

      // Toggle Markdown Edit/Preview in Notes view
      if (metaOrCtrl && lower === "p" && !ignore) {
        if (view !== "notes") return;
        if (!activeSelectedNote) return;
        e.preventDefault();
        setEditorMode((m) => (m === "edit" ? "preview" : "edit"));
        return;
      }

      // Delete shortcut when NOT typing
      if ((key === "Delete" || key === "Backspace") && !ignore) {
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
        if (!trashSelectedNote) return;
        e.preventDefault();
        restoreSelectedNoteFromTrash();
        return;
      }

      // Global escape: if not in an input, clear the search (matches user expectation).
      if (key === "Escape" && !ignore) {
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
    activeSelectedNote,
    trashSelectedNote,
    // actions
    createNewNote,
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

  const emptyState = notes.length === 0;
  const emptyTrashState = trashedNotes.length === 0;

  return (
    <div className="App" data-retro="true">
      <div className="retro-bg" aria-hidden="true" />
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
                • {view === "trash" ? "TRASH" : "NOTES"}
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

          <div className="retro-viewtoggle" role="group" aria-label="Notes view">
            <button
              type="button"
              className={`btn ${view === "notes" ? "btn-primary" : ""}`}
              onClick={() => setView("notes")}
              aria-pressed={view === "notes" ? "true" : "false"}
              title="Show notes"
            >
              Notes ({notes.length})
            </button>
            <button
              type="button"
              className={`btn ${view === "trash" ? "btn-primary" : ""}`}
              onClick={() => setView("trash")}
              aria-pressed={view === "trash" ? "true" : "false"}
              title="Show trash"
            >
              Trash ({trashedNotes.length})
            </button>
          </div>

          <button
            type="button"
            className="btn"
            onClick={() => importInputRef.current?.click()}
            title="Import notes from JSON"
          >
            Import
          </button>

          <button
            type="button"
            className="btn"
            onClick={exportNotesToJson}
            disabled={notes.length === 0 && trashedNotes.length === 0}
            title={
              notes.length === 0 && trashedNotes.length === 0
                ? "No notes to export"
                : "Export notes to JSON"
            }
          >
            Export
          </button>

          <button className="btn btn-primary" onClick={createNewNote}>
            + New note
          </button>
        </div>
      </header>

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

                    <div
                      className="retro-segtoggle"
                      role="tablist"
                      aria-label="Editor mode"
                    >
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
                        className={`btn btn-small ${editorMode === "preview" ? "btn-primary" : ""}`}
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
                          // Keep Markdown rendering strictly "preview-only" and safe:
                          // - no raw HTML rendering (default behavior)
                          // - open links safely
                          components={{
                            a: ({ node, ...props }) => (
                              <a {...props} target="_blank" rel="noopener noreferrer" />
                            ),
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
                    Tip: Use <kbd>Save</kbd> after edits. Notes are stored in this browser
                    (localStorage).
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

      <footer className="retro-footerbar">
        <div className="retro-footerbar__left">
          <span className="retro-pip" aria-hidden="true" />
          <span>
            {view === "trash" ? "Trash" : "Notes"}:{" "}
            <strong>
              {query.trim() || (view === "notes" && normalizeTag(activeTag))
                ? `${resultsCount} / ${totalCount}`
                : totalCount}
            </strong>
          </span>
        </div>

        <div className="retro-footerbar__right">
          <span className="retro-mono">
            <kbd>Ctrl/⌘</kbd>+<kbd>N</kbd> new • <kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> search •{" "}
            <kbd>Ctrl/⌘</kbd>+<kbd>1</kbd>/<kbd>2</kbd> views •{" "}
            {view === "trash" ? (
              <>
                <kbd>R</kbd> restore • <kbd>Del</kbd> delete
              </>
            ) : (
              <>
                <kbd>Ctrl/⌘</kbd>+<kbd>P</kbd> preview • <kbd>Del</kbd> trash
              </>
            )}
          </span>
        </div>
      </footer>
    </div>
  );
}

export default App;
