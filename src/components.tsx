import { Check, Copy, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { pair } from "./model";
import type { Pair } from "./types";

export function IconButton({
  children,
  label,
  onClick,
  className = "",
  disabled = false,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`icon-button ${className}`}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function PairEditor({
  rows,
  onChange,
  kind = "Parameter",
  valuePlaceholder = "Value",
}: {
  rows: Pair[];
  onChange: (rows: Pair[]) => void;
  kind?: string;
  valuePlaceholder?: string;
}) {
  function update(id: string, patch: Partial<Pair>) {
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  return (
    <div className="pairs-table">
      <div className="pairs-head">
        <span />
        <span>KEY</span>
        <span>VALUE</span>
        <span />
      </div>
      {rows.map((row) => (
        <div
          className={`pairs-row ${!row.enabled ? "disabled-row" : ""}`}
          key={row.id}
        >
          <input
            type="checkbox"
            aria-label={`Enable ${kind.toLowerCase()} ${row.key || "row"}`}
            checked={row.enabled}
            onChange={(e) => update(row.id, { enabled: e.target.checked })}
          />
          <input
            aria-label={`${kind} key`}
            placeholder="Key"
            value={row.key}
            spellCheck={false}
            onChange={(e) => update(row.id, { key: e.target.value })}
          />
          <input
            aria-label={`${kind} value`}
            placeholder={valuePlaceholder}
            value={row.value}
            spellCheck={false}
            onChange={(e) => update(row.id, { value: e.target.value })}
          />
          <IconButton
            label={`Remove ${kind.toLowerCase()} ${row.key || "row"}`}
            onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
          >
            <Trash2 size={13} />
          </IconButton>
        </div>
      ))}
      <button className="add-pair" onClick={() => onChange([...rows, pair()])}>
        <Plus size={13} /> Add {kind.toLowerCase()}
      </button>
    </div>
  );
}

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const first =
      root?.querySelector<HTMLElement>("input,select,textarea") ??
      root?.querySelector<HTMLElement>("button");
    first?.focus();
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "Tab" && root) {
        const items = [
          ...root.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input,select,textarea,[tabindex="0"]',
          ),
        ];
        const first = items[0],
          last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide" : ""}`}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <IconButton label="Close dialog" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}

export function CopyButton({
  text,
  label = "Copy",
  onError,
}: {
  text: string;
  label?: string;
  onError?: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      className="subtle-button"
      title={label}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1600);
        } catch {
          onError?.(
            "Clipboard access failed. Select and copy the text manually.",
          );
        }
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}{" "}
      {copied ? "Copied" : label}
    </button>
  );
}

export function CodeViewer({
  text,
  search = "",
}: {
  text: string;
  search?: string;
}) {
  const lines = text.split("\n");
  const maxLines = 6000;
  const tokens =
    /("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g;
  return (
    <div className="code-viewer" tabIndex={0} aria-label="Response body">
      {lines.slice(0, maxLines).map((line, index) => (
        <div
          className={`code-line ${search && line.toLowerCase().includes(search.toLowerCase()) ? "search-match" : ""}`}
          key={index}
        >
          <span className="line-number">{index + 1}</span>
          <code>
            {line.split(tokens).map((part, i) => {
              const type = part.startsWith('"')
                ? part.trimEnd().endsWith(":")
                  ? "key"
                  : "string"
                : /^(true|false|null)$/.test(part)
                  ? "boolean"
                  : /^-?\d/.test(part)
                    ? "number"
                    : "";
              return (
                <span className={type ? `syntax-${type}` : undefined} key={i}>
                  {part}
                </span>
              );
            })}
            {!line && " "}
          </code>
        </div>
      ))}
      {lines.length > maxLines && (
        <div className="code-limit">
          Showing the first {maxLines} lines. Download the response to view the
          full captured body.
        </div>
      )}
    </div>
  );
}
