import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useAnchoredMenu } from "../lib/useAnchoredMenu";

export function ChoicePicker({
  label,
  value,
  options,
  onChange,
  prefix,
  className = "",
  disabled = false,
  title,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  onChange: (value: string) => void;
  prefix?: ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  useAnchoredMenu(ref, true);
  const selected = options.find((option) => option.value === value);
  const close = () => {
    setOpen(false);
    ref.current?.querySelector("summary")?.focus();
  };
  useEffect(() => {
    if (open)
      (
        ref.current?.querySelector<HTMLElement>(
          '[role="option"][aria-selected="true"]:not(:disabled)',
        ) ?? ref.current?.querySelector<HTMLElement>('[role="option"]:not(:disabled)')
      )?.focus();
  }, [open]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  return (
    <details
      ref={ref}
      className={`choice-picker ${className}`}
      open={open && !disabled}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || disabled) return;
        event.preventDefault();
        event.stopPropagation();
        if (!open) {
          setOpen(true);
          return;
        }
        const items = Array.from(
          ref.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [],
        );
        if (!items.length) return;
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const index =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
        items[index]?.focus();
      }}
    >
      <summary
        className="choice-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open && !disabled}
        aria-controls={id}
        aria-disabled={disabled}
        title={title}
        tabIndex={disabled ? -1 : 0}
        onClick={(event) => {
          event.preventDefault();
          if (!disabled) setOpen((value) => !value);
        }}
      >
        {prefix}
        <span className="choice-value">{selected?.label ?? value}</span>
        <svg
          className="choice-chevron"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className="choice-menu" hidden={!open || disabled}>
        <div id={id} role="listbox" aria-label={`${label} options`}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              disabled={option.disabled}
              aria-selected={option.value === value}
              onClick={() => {
                if (!option.disabled) {
                  onChange(option.value);
                  close();
                }
              }}
            >
              <span>{option.label}</span>
              <span className="choice-check" aria-hidden="true">
                {option.value === value ? "✓" : ""}
              </span>
            </button>
          ))}
        </div>
      </div>
    </details>
  );
}
