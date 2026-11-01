import { useEffect, type RefObject } from "react";

/** Keep a details panel beside its trigger and inside the visible viewport. */
export function useAnchoredMenu(
  ref: RefObject<HTMLDetailsElement | null>,
  matchTriggerWidth = false,
) {
  useEffect(() => {
    const details = ref.current;
    if (!details) return;
    const panel = details.querySelector<HTMLElement>(":scope > div");
    const trigger = details.querySelector("summary");
    if (!panel || !trigger) return;
    const place = () => {
      if (!details.open) return;
      const bounds = trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const offsetX = viewport?.offsetLeft ?? 0;
      const offsetY = viewport?.offsetTop ?? 0;
      const gap = 8;
      const below = height + offsetY - bounds.bottom - gap * 2;
      const above = bounds.top - offsetY - gap * 2;
      panel.style.position = "fixed";
      panel.style.margin = "0";
      panel.style.bottom = "auto";
      panel.style.maxWidth = `${Math.max(0, width - gap * 2)}px`;
      if (matchTriggerWidth)
        panel.style.minWidth = `${Math.max(0, Math.min(bounds.width, width - gap * 2))}px`;
      const upwards = below < Math.min(panel.scrollHeight, 280) && above > below;
      panel.style.maxHeight = `${Math.max(0, upwards ? above : below)}px`;
      panel.style.overflowY = "auto";
      const size = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(offsetX + gap, Math.min(bounds.right - size.width, offsetX + width - size.width - gap))}px`;
      panel.style.right = "auto";
      panel.style.top = `${upwards ? bounds.top - size.height - gap : bounds.bottom + gap}px`;
    };
    details.addEventListener("toggle", place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(panel);
    return () => {
      details.removeEventListener("toggle", place);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      observer?.disconnect();
    };
  }, [ref, matchTriggerWidth]);
}
