import { useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { RELEASE_SOURCE_URL } from "@vektor/shared";

export function ReleaseLink({ href, children }: { href: string; children: ReactNode }) {
  const [error, setError] = useState(false);
  if (!href.startsWith(`${RELEASE_SOURCE_URL}/releases/tag/`)) return null;
  return (
    <span>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-emerald-300 hover:underline"
        onClick={
          isTauri()
            ? (event) => {
                event.preventDefault();
                void openUrl(href).catch(() => setError(true));
              }
            : undefined
        }
      >
        {children}
      </a>
      {error ? (
        <span role="alert" className="ml-2 text-amber-200">
          Open this release URL in your browser: {href}
        </span>
      ) : null}
    </span>
  );
}
