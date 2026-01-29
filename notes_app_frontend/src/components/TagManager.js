import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * TagManager modal: view all tags and perform global operations:
 * - rename (changes tag across all active notes)
 * - merge (moves all notes from source tag(s) into target tag)
 * - delete (removes tag from all active notes)
 *
 * This component is intentionally "dumb": it receives tags + callbacks from App.
 */

/**
 * @typedef {Object} TagStats
 * @property {string} tag Normalized tag string.
 * @property {number} count Number of active notes containing the tag.
 */

/**
 * @typedef {Object} TagManagerProps
 * @property {boolean} isOpen
 * @property {() => void} onClose
 * @property {TagStats[]} tagStats
 * @property {(tag: string) => void} onFocusTag Optional: focus/tag-filter a tag in the main UI.
 * @property {(fromTag: string, toTag: string) => {ok: boolean, message?: string}} onRenameTag
 * @property {(fromTags: string[], toTag: string) => {ok: boolean, message?: string}} onMergeTags
 * @property {(tag: string) => {ok: boolean, message?: string}} onDeleteTag
 */

function normalizeTag(raw) {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function plural(n, s, p) {
  return n === 1 ? s : p || `${s}s`;
}

export default function TagManager({
  isOpen,
  onClose,
  tagStats,
  onFocusTag,
  onRenameTag,
  onMergeTags,
  onDeleteTag,
}) {
  const [query, setQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState(() => new Set());
  const [renameFrom, setRenameFrom] = useState("");
  const [renameTo, setRenameTo] = useState("");
  const [mergeTo, setMergeTo] = useState("");
  const [error, setError] = useState("");

  const inputRef = useRef(null);

  const filtered = useMemo(() => {
    const q = normalizeTag(query);
    const list = Array.isArray(tagStats) ? tagStats : [];
    if (!q) return list;
    return list.filter((t) => t.tag.includes(q));
  }, [tagStats, query]);

  useEffect(() => {
    if (!isOpen) return;
    setQuery("");
    setError("");
    setSelectedTags(new Set());
    setRenameFrom("");
    setRenameTo("");
    setMergeTo("");

    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [isOpen]);

  function toggleSelected(tag) {
    const norm = normalizeTag(tag);
    if (!norm) return;
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(norm)) next.delete(norm);
      else next.add(norm);
      return next;
    });
  }

  function selectedCount() {
    return selectedTags.size;
  }

  function selectedList() {
    return Array.from(selectedTags.values()).sort((a, b) => a.localeCompare(b));
  }

  function runRename() {
    setError("");
    const from = normalizeTag(renameFrom);
    const to = normalizeTag(renameTo);

    if (!from || !to) {
      setError("Rename requires both 'From' and 'To'.");
      return;
    }
    const res = onRenameTag?.(from, to) || { ok: false, message: "Rename unavailable." };
    if (!res.ok) {
      setError(res.message || "Rename failed.");
      return;
    }
    setRenameFrom("");
    setRenameTo("");
  }

  function runMerge() {
    setError("");
    const to = normalizeTag(mergeTo);
    const fromTags = selectedList().map(normalizeTag).filter(Boolean);

    if (fromTags.length < 1) {
      setError("Select one or more tags to merge.");
      return;
    }
    if (!to) {
      setError("Merge requires a target tag (To).");
      return;
    }

    const res = onMergeTags?.(fromTags, to) || { ok: false, message: "Merge unavailable." };
    if (!res.ok) {
      setError(res.message || "Merge failed.");
      return;
    }

    setSelectedTags(new Set());
    setMergeTo("");
  }

  function runDelete(tag) {
    setError("");
    const norm = normalizeTag(tag);
    if (!norm) return;

    const res = onDeleteTag?.(norm) || { ok: false, message: "Delete unavailable." };
    if (!res.ok) {
      setError(res.message || "Delete failed.");
      return;
    }

    // Keep selection in sync if the deleted tag was selected.
    setSelectedTags((prev) => {
      if (!prev.has(norm)) return prev;
      const next = new Set(prev);
      next.delete(norm);
      return next;
    });
  }

  if (!isOpen) return null;

  return (
    <div
      className="tm-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        className="tm-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Tag manager"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose?.();
          }
        }}
      >
        <div className="tm-head">
          <div className="tm-title">Tag Manager</div>
          <div className="tm-head__actions">
            <button type="button" className="btn btn-small" onClick={onClose} title="Close">
              Close
            </button>
          </div>
        </div>

        <div className="tm-body">
          <div className="tm-left">
            <label className="tm-label" htmlFor="tm-search">
              Find tag
            </label>
            <input
              id="tm-search"
              ref={inputRef}
              className="retro-input tm-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tags…"
              autoComplete="off"
              spellCheck="false"
            />

            <div className="tm-list" role="list" aria-label="All tags">
              {filtered.length === 0 ? (
                <div className="tm-empty" role="status">
                  No tags.
                </div>
              ) : (
                filtered.map((t) => {
                  const selected = selectedTags.has(t.tag);
                  return (
                    <div key={t.tag} className="tm-row" role="listitem">
                      <button
                        type="button"
                        className={`tm-tag ${selected ? "is-selected" : ""}`}
                        onClick={() => toggleSelected(t.tag)}
                        aria-pressed={selected ? "true" : "false"}
                        title={selected ? "Unselect" : "Select for merge"}
                      >
                        <span className="tm-tag__text">#{t.tag}</span>
                        <span className="tm-tag__count">
                          {t.count} {plural(t.count, "note")}
                        </span>
                      </button>

                      <div className="tm-row__actions">
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => onFocusTag?.(t.tag)}
                          title={`Filter by ${t.tag}`}
                        >
                          Filter
                        </button>
                        <button
                          type="button"
                          className="btn btn-small btn-danger"
                          onClick={() => runDelete(t.tag)}
                          title={`Delete tag ${t.tag} from all notes`}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="tm-meta" aria-live="polite">
              {Array.isArray(tagStats) ? tagStats.length : 0} total • {filtered.length} shown •{" "}
              {selectedCount()} selected
            </div>
          </div>

          <div className="tm-right">
            <div className="tm-panel" aria-label="Rename tag">
              <div className="tm-panel__title">Rename</div>
              <div className="tm-grid">
                <label className="tm-field">
                  <span className="tm-field__label">From</span>
                  <input
                    className="retro-input"
                    value={renameFrom}
                    onChange={(e) => setRenameFrom(e.target.value)}
                    placeholder="old-tag"
                  />
                </label>
                <label className="tm-field">
                  <span className="tm-field__label">To</span>
                  <input
                    className="retro-input"
                    value={renameTo}
                    onChange={(e) => setRenameTo(e.target.value)}
                    placeholder="new-tag"
                  />
                </label>
              </div>

              <div className="tm-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={runRename}
                  disabled={!normalizeTag(renameFrom) || !normalizeTag(renameTo)}
                  title="Rename tag across all notes"
                >
                  Rename
                </button>
              </div>

              <div className="tm-help">
                Tip: Renaming to an existing tag effectively merges them.
              </div>
            </div>

            <div className="tm-panel" aria-label="Merge tags">
              <div className="tm-panel__title">Merge</div>

              <div className="tm-help">
                Selected tags:{" "}
                <span className="tm-mono">
                  {selectedCount() ? selectedList().map((t) => `#${t}`).join(" ") : "(none)"}
                </span>
              </div>

              <label className="tm-field">
                <span className="tm-field__label">To</span>
                <input
                  className="retro-input"
                  value={mergeTo}
                  onChange={(e) => setMergeTo(e.target.value)}
                  placeholder="target-tag"
                />
              </label>

              <div className="tm-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={runMerge}
                  disabled={selectedCount() === 0 || !normalizeTag(mergeTo)}
                  title="Merge selected tags into target"
                >
                  Merge selected → target
                </button>

                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => setSelectedTags(new Set())}
                  disabled={selectedCount() === 0}
                  title="Clear selection"
                >
                  Clear selection
                </button>
              </div>

              <div className="tm-help">
                Notes keep their other tags. Duplicates are removed automatically.
              </div>
            </div>

            {error ? (
              <div className="retro-alert" role="alert">
                {error}
              </div>
            ) : null}
          </div>
        </div>

        <div className="tm-footer">
          <span className="tm-footer__left">
            <kbd>Esc</kbd> close • Click tags to select for merge
          </span>
          <span className="tm-footer__right">Retro Notes • Tags are case-insensitive</span>
        </div>
      </div>
    </div>
  );
}
