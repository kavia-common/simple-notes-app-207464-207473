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
 * @property {string[]} tags
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

// PUBLIC_INTERFACE
function App() {
  /** @type {[Note[], Function]} */
  const [notes, setNotes] = useState([]);
  const [selectedId, setSelectedId] = useState(null);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [query, setQuery] = useState("");

  // Tag filter: which tag is currently selected in the list filter.
  const [activeTag, setActiveTag] = useState("");

  // Tag input for the selected note.
  const [tagDraft, setTagDraft] = useState("");

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
            tags: Array.isArray(n.tags)
              ? Array.from(
                  new Set(
                    n.tags.map((t) => normalizeTag(t)).filter(Boolean)
                  )
                )
              : [],
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

  const allTags = useMemo(() => {
    const set = new Set();
    for (const n of notes) {
      for (const t of n.tags || []) set.add(normalizeTag(t));
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [notes]);

  const filteredNotes = useMemo(() => {
    const q = query.trim().toLowerCase();
    const tag = normalizeTag(activeTag);

    // Preserve existing search behavior, then apply tag filtering on top.
    return notes.filter((n) => {
      if (tag) {
        const tagMatch = (n.tags || []).map(normalizeTag).includes(tag);
        if (!tagMatch) return false;
      }

      if (!q) return true;
      const hay = `${n.title}\n${n.body}`.toLowerCase();
      return hay.includes(q);
    });
  }, [notes, query, activeTag]);

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
      setTagDraft("");
      return;
    }
    setTitle(selectedNote.title);
    setBody(selectedNote.body);
    setTagDraft("");
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
      tags: [],
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

  // PUBLIC_INTERFACE
  function addTagsToSelectedNote(rawInput) {
    /** Add one or more tags to the selected note. Accepts comma-separated input. */
    setError("");

    if (!selectedNote) {
      setError("No note selected.");
      return;
    }

    const newTags = parseTagsInput(rawInput);
    if (newTags.length === 0) return;

    setNotes((prev) => {
      const next = prev.map((n) => {
        if (n.id !== selectedNote.id) return n;
        const merged = Array.from(
          new Set([...(n.tags || []).map(normalizeTag), ...newTags])
        );
        return { ...n, tags: merged };
      });
      // Sorting not strictly needed, but keep behavior consistent (pins/updatedAt)
      next.sort(sortNotesPinnedFirst);
      return next;
    });

    setTagDraft("");
  }

  // PUBLIC_INTERFACE
  function removeTagFromSelectedNote(tagToRemove) {
    /** Remove a tag from the selected note. */
    setError("");

    if (!selectedNote) {
      setError("No note selected.");
      return;
    }

    const norm = normalizeTag(tagToRemove);
    if (!norm) return;

    setNotes((prev) => {
      const next = prev.map((n) => {
        if (n.id !== selectedNote.id) return n;
        const filtered = (n.tags || []).map(normalizeTag).filter((t) => t !== norm);
        return { ...n, tags: filtered };
      });
      next.sort(sortNotesPinnedFirst);
      return next;
    });

    // If the user is currently filtering by a tag that got removed from all notes,
    // keep the filter (it will simply show zero results) rather than changing behavior.
  }

  // PUBLIC_INTERFACE
  function toggleActiveTag(tag) {
    /** Toggle tag filter on/off. */
    const norm = normalizeTag(tag);
    setActiveTag((prev) => (normalizeTag(prev) === norm ? "" : norm));
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

            <div id="search-help" className="retro-search__meta" aria-live="polite">
              {query.trim() || normalizeTag(activeTag)
                ? `Showing ${resultsCount} of ${totalCount}`
                : `Showing all ${totalCount}`}
              {normalizeTag(activeTag) ? ` • TAG: ${normalizeTag(activeTag)}` : ""}
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
                const noteTags = (n.tags || []).map(normalizeTag).filter(Boolean);

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
                        {noteTags.length ? ` • ${noteTags.length} TAGS` : ""}
                      </div>

                      {noteTags.length ? (
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

              <div className="retro-field">
                <label className="retro-label" htmlFor="tags">
                  Tags
                </label>

                <div className="retro-tags-editor" aria-label="Tags editor">
                  <div className="retro-tags-editor__chips" aria-label="Selected note tags">
                    {(selectedNote.tags || []).length === 0 ? (
                      <span className="retro-tags-editor__empty">No tags assigned.</span>
                    ) : (
                      (selectedNote.tags || []).map((t) => {
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
              {query.trim() || normalizeTag(activeTag)
                ? `${resultsCount} / ${totalCount}`
                : totalCount}
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
