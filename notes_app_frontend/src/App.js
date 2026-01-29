import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/**
 * Small helper to generate reasonably-unique ids without adding dependencies.
 * Good enough for local-only notes.
 */
function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const STORAGE_KEY = "retro_notes_v1";

/**
 * @typedef {Object} Note
 * @property {string} id
 * @property {string} title
 * @property {string} body
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {boolean} pinned
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

// PUBLIC_INTERFACE
function App() {
  /** @type {[Note[], Function]} */
  const [notes, setNotes] = useState([]);
  const [selectedId, setSelectedId] = useState(null);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [query, setQuery] = useState("");

  const [error, setError] = useState("");
  const titleInputRef = useRef(null);

  // Load from localStorage once.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // Basic validation / normalization
        const normalized = parsed
          .filter((n) => n && typeof n.id === "string")
          .map((n) => ({
            id: String(n.id),
            title: typeof n.title === "string" ? n.title : "",
            body: typeof n.body === "string" ? n.body : "",
            createdAt: Number.isFinite(n.createdAt) ? n.createdAt : Date.now(),
            updatedAt: Number.isFinite(n.updatedAt) ? n.updatedAt : Date.now(),
            pinned: Boolean(n.pinned),
          }))
          .sort(sortNotesPinnedFirst);

        setNotes(normalized);
        if (normalized.length > 0) {
          setSelectedId(normalized[0].id);
        }
      }
    } catch (e) {
      // Corrupted storage should not brick the UI.
      console.error("Failed to load notes from storage:", e);
      setError("Could not load saved notes (storage looked corrupted).");
    }
  }, []);

  // Persist whenever notes change.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
    } catch (e) {
      console.error("Failed to persist notes:", e);
      setError("Storage is full or unavailable. Changes may not persist.");
    }
  }, [notes]);

  const selectedNote = useMemo(() => {
    if (!selectedId) return null;
    return notes.find((n) => n.id === selectedId) || null;
  }, [notes, selectedId]);

  const filteredNotes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes;

    return notes.filter((n) => {
      const hay = `${n.title}\n${n.body}`.toLowerCase();
      return hay.includes(q);
    });
  }, [notes, query]);

  const filteredNotesPinnedFirst = useMemo(() => {
    // Keep the current search/filter behavior, but present pinned items first
    // within the filtered results.
    return [...filteredNotes].sort(sortNotesPinnedFirst);
  }, [filteredNotes]);

  const resultsCount = filteredNotesPinnedFirst.length;
  const totalCount = notes.length;

  // Keep editor fields in sync with selected note.
  useEffect(() => {
    setError("");
    if (!selectedNote) {
      setTitle("");
      setBody("");
      return;
    }
    setTitle(selectedNote.title);
    setBody(selectedNote.body);
  }, [selectedNote]);

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
    };

    setNotes((prev) => [newNote, ...prev].sort(sortNotesPinnedFirst));
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

    if (!selectedNote) {
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
        n.id === selectedNote.id
          ? {
              ...n,
              title: nextTitle,
              body: trimmedBody,
              updatedAt: now,
            }
          : n
      );
      // Keep pinned on top, then most recently updated
      updated.sort(sortNotesPinnedFirst);
      return updated;
    });
  }

  // PUBLIC_INTERFACE
  function deleteSelectedNote() {
    setError("");
    if (!selectedNote) {
      setError("No note selected.");
      return;
    }

    const ok = window.confirm(`Delete "${selectedNote.title || "Untitled"}"?`);
    if (!ok) return;

    setNotes((prev) => {
      const next = prev.filter((n) => n.id !== selectedNote.id);
      // pick next selection
      setSelectedId(next.length ? next[0].id : null);
      return next;
    });
  }

  // PUBLIC_INTERFACE
  function togglePin(noteId) {
    /** Toggle pin/unpin for a note. */
    setNotes((prev) => {
      const next = prev.map((n) =>
        n.id === noteId ? { ...n, pinned: !Boolean(n.pinned) } : n
      );
      next.sort(sortNotesPinnedFirst);
      return next;
    });
  }

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
            <p className="retro-subtitle">Add, edit, delete — all offline.</p>
          </div>
        </div>

        <div className="retro-header__right">
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
                id="search"
                className="retro-input retro-search__input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setQuery("");
                }}
                placeholder="Type to filter…"
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

            <div id="search-help" className="retro-search__meta" aria-live="polite">
              {query.trim()
                ? `Showing ${resultsCount} of ${totalCount}`
                : `Showing all ${totalCount}`}
            </div>
          </div>

          <div className="retro-list" role="list">
            {filteredNotesPinnedFirst.length === 0 ? (
              <div className="retro-empty" role="status">
                No matches.
              </div>
            ) : (
              filteredNotesPinnedFirst.map((n) => {
                const active = n.id === selectedId;
                const preview =
                  (n.body || "")
                    .replace(/\s+/g, " ")
                    .trim()
                    .slice(0, 70) || "…";
                const isPinned = Boolean(n.pinned);

                return (
                  <div
                    key={n.id}
                    className={`retro-note-card-wrap ${active ? "is-active" : ""}`}
                    role="listitem"
                    aria-current={active ? "true" : "false"}
                  >
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

                    <button
                      className={`retro-note-card ${active ? "is-active" : ""}`}
                      onClick={() => setSelectedId(n.id)}
                      type="button"
                    >
                      <div className="retro-note-card__title">
                        {n.title || "Untitled"}
                      </div>
                      <div className="retro-note-card__meta">
                        {formatDate(n.updatedAt)}
                        {isPinned ? " • PINNED" : ""}
                      </div>
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
                    Editing:{" "}
                    <strong className="retro-status__strong">
                      {selectedNote.title || "Untitled"}
                    </strong>
                  </>
                ) : emptyState ? (
                  "No notes yet."
                ) : (
                  "Select a note to edit."
                )}
              </span>
            </div>

            <div className="retro-toolbar__right">
              <button
                className="btn"
                onClick={() => {
                  if (!selectedNote) return;
                  togglePin(selectedNote.id);
                }}
                disabled={!selectedNote}
                title={selectedNote?.pinned ? "Unpin note" : "Pin note"}
              >
                {selectedNote?.pinned ? "Unpin" : "Pin"}
              </button>

              <button
                className="btn"
                onClick={saveSelectedNote}
                disabled={!selectedNote}
                title="Save changes"
              >
                Save
              </button>
              <button
                className="btn btn-danger"
                onClick={deleteSelectedNote}
                disabled={!selectedNote}
                title="Delete note"
              >
                Delete
              </button>
            </div>
          </div>

          {error ? (
            <div className="retro-alert" role="alert">
              {error}
            </div>
          ) : null}

          {selectedNote ? (
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
                <label className="retro-label" htmlFor="body">
                  Note
                </label>
                <textarea
                  id="body"
                  className="retro-textarea"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Write something…"
                  rows={12}
                />
              </div>

              <div className="retro-footer">
                <div className="retro-hint">
                  Tip: Use <kbd>Save</kbd> after edits. Notes are stored in this
                  browser (localStorage).
                </div>
                <div className="retro-timestamps">
                  <span>
                    Created: <strong>{formatDate(selectedNote.createdAt)}</strong>
                  </span>
                  <span>
                    Updated: <strong>{formatDate(selectedNote.updatedAt)}</strong>
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="retro-placeholder" role="status">
              {emptyState ? (
                <>
                  <div className="retro-placeholder__title">
                    Your desktop is empty.
                  </div>
                  <div className="retro-placeholder__body">
                    Create your first note to begin.
                  </div>
                  <button className="btn btn-primary" onClick={createNewNote}>
                    + New note
                  </button>
                </>
              ) : (
                <>
                  <div className="retro-placeholder__title">
                    Select a note to edit.
                  </div>
                  <div className="retro-placeholder__body">
                    Pick one from the list on the left, or create a new note.
                  </div>
                  <button className="btn btn-primary" onClick={createNewNote}>
                    + New note
                  </button>
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
            Notes:{" "}
            <strong>
              {query.trim() ? `${resultsCount} / ${totalCount}` : totalCount}
            </strong>
          </span>
        </div>
        <div className="retro-footerbar__right">
          <span className="retro-mono">LOCAL • OFFLINE • NO BACKEND</span>
        </div>
      </footer>
    </div>
  );
}

export default App;
