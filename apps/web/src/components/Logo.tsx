import logoUrl from "../../src-tauri/icons/icon.svg";

export function Logo({ className = "h-8 w-8" }: { className?: string }) {
  return <img src={logoUrl} alt="" aria-hidden="true" className={`shrink-0 ${className}`} />;
}
