import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * @typedef {Object} CommandPaletteItem
 * @property {string} id Unique id for stable list rendering.
 * @property {string} label Display label.
 * @property {string=} hint Optional keyboard hint shown on the right.
 * @property {string[]=} keywords Additional keywords to help matching.
 * @property {boolean=} disabled If true, the item is visible but not selectable.
 * @property {string=} disabledReason Optional reason shown as subtle hint.
 * @property {() => void} run Action to execute when selected.
 */

/**
 * Very small, dependency-free fuzzy-ish matching:
 * - tokenizes query by whitespace
 * - each token must be a substring of the candidate string
 */
function matchesQuery(candidate, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;

  const tokens = q.split(/\s+/g).filter(Boolean);
  const c = String(candidate || "").toLowerCase();

  return tokens.every((t) => c.includes(t));
}

function keyForItem(item) {
  const parts = [
    item.label,
    ...(Array.isArray(item.keywords) ? item.keywords : []),
    item.hint || "",
    item.disabledReason || "",
  ];
  return parts.filter(Boolean).join(" • ");
}

/**
 * CommandPalette shows a modal overlay with a search box and a list of commands.
 *
 * Keyboard:
 * - Esc: close
 * - ↑/↓: navigate
 * - Enter: run selected
 */
export default function CommandPalette({ isOpen, onClose, items }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef(null);
  const listRef = useRef(null);

  const filtered = useMemo(() => {
    const list = Array.isArray(items) ? items : [];
    return list.filter((it) => matchesQuery(keyForItem(it), query));
  }, [items, query]);

  // Reset state whenever opened.
  useEffect(() => {
    if (!isOpen) return;
    setQuery("");
    setActiveIndex(0);

    // Focus input on next tick so the modal is mounted.
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [isOpen]);

  // Clamp active index whenever filtered list changes.
  useEffect(() => {
    setActiveIndex((idx) => {
      if (filtered.length === 0) return 0;
      return Math.min(Math.max(0, idx), filtered.length - 1);
    });
  }, [filtered.length]);

  // Ensure active item is visible in scroll container.
  useEffect(() => {
    if (!isOpen) return;
    const el = listRef.current?.querySelector(`[data-cp-index="${activeIndex}"]`);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, isOpen]);

  function runItem(item) {
    if (!item || item.disabled) return;
    try {
      item.run?.();
    } finally {
      onClose?.();
    }
  }

  if (!isOpen) return null;

  return (
    <div
      className="cp-overlay"
      role="presentation"
      onMouseDown={(e) => {
        // Click outside closes; click inside should not.
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        className="cp-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => {
          // Prevent outside handler when clicking inside.
          e.stopPropagation();
        }}
        onKeyDown={(e) => {
          const key = String(e.key || "");
          if (key === "Escape") {
            e.preventDefault();
            onClose?.();
            return;
          }
          if (key === "ArrowDown") {
            e.preventDefault();
            setActiveIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
            return;
          }
          if (key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((i) => Math.max(0, i - 1));
            return;
          }
          if (key === "Enter") {
            e.preventDefault();
            const item = filtered[activeIndex];
            runItem(item);
          }
        }}
      >
        <div className="cp-head">
          <div className="cp-title">Command Palette</div>
          <div className="cp-kbd" aria-hidden="true">
            <kbd>Esc</kbd>
          </div>
        </div>

        <label className="cp-label" htmlFor="cp-search">
          Type a command
        </label>
        <input
          id="cp-search"
          ref={inputRef}
          className="retro-input cp-input"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          placeholder="Search… (e.g., new, theme, export)"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck="false"
        />

        <div className="cp-list" role="listbox" aria-label="Commands" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="cp-empty" role="status">
              No matches.
            </div>
          ) : (
            filtered.map((it, idx) => {
              const active = idx === activeIndex;
              const disabled = Boolean(it.disabled);
              return (
                <button
                  key={it.id}
                  type="button"
                  className={`cp-item ${active ? "is-active" : ""} ${
                    disabled ? "is-disabled" : ""
                  }`}
                  role="option"
                  aria-selected={active ? "true" : "false"}
                  aria-disabled={disabled ? "true" : "false"}
                  data-cp-index={idx}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => runItem(it)}
                  disabled={disabled}
                  title={disabled && it.disabledReason ? it.disabledReason : it.label}
                >
                  <span className="cp-item__label">{it.label}</span>
                  <span className="cp-item__right">
                    {disabled && it.disabledReason ? (
                      <span className="cp-item__meta">{it.disabledReason}</span>
                    ) : it.hint ? (
                      <span className="cp-item__hint">{it.hint}</span>
                    ) : null}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="cp-footer">
          <span className="cp-footer__left">
            <kbd>↑</kbd>/<kbd>↓</kbd> navigate • <kbd>Enter</kbd> run
          </span>
          <span className="cp-footer__right">
            Tip: <kbd>Ctrl/⌘</kbd>+<kbd>K</kbd>
          </span>
        </div>
      </div>
    </div>
  );
}
