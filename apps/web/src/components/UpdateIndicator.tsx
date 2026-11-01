import { useEffect, useState } from "react";
import type { UpdateCheck } from "@vektor/shared";
import type { ApiClient } from "../lib/api";
import { ReleaseLink } from "./ReleaseLink";

export function UpdateIndicator({ client }: { client: ApiClient }) {
  const [info, setInfo] = useState<UpdateCheck | null>(null);
  useEffect(() => {
    let active = true;
    const load = () => {
      void client
        .updateCheck()
        .then((value) => {
          if (active) setInfo(value);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client]);
  return info?.updateAvailable && info.releaseUrl ? (
    <span className="rounded-full border border-emerald-400/20 px-2 py-1 text-[11px]">
      <ReleaseLink href={info.releaseUrl}>v{info.latestVersion} available</ReleaseLink>
    </span>
  ) : null;
}
