import { useAnchoredMenu } from "../lib/useAnchoredMenu";
import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

export function OverflowMenu({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useAnchoredMenu(ref);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  return (
    <details
      className="action-menu"
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}
    >
      <summary aria-label={label} title={label}>
        <Icon name="more" />
      </summary>
      <div
        className="action-menu-content"
        onClick={(event) => {
          const button = (event.target as HTMLElement).closest("button");
          if (button && !button.disabled && ref.current) {
            ref.current.open = false;
            ref.current.querySelector("summary")?.focus();
          }
        }}
      >
        {children}
      </div>
    </details>
  );
}
