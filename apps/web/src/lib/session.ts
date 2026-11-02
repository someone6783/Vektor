// Consume fragment credentials once, including under React StrictMode. Never log the link.
let pending: Promise<boolean> | undefined;
export function connectBrowserSession(): Promise<boolean> {
  return (pending ??= (async () => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const code = params.get("setup");
    if (code) {
      const search = new URLSearchParams(window.location.search);
      search.delete("signin");
      const query = search.size ? `?${search}` : "";
      window.history.replaceState(null, "", window.location.pathname + query);
      const response = await fetch("/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        credentials: "same-origin",
      });
      if (!response.ok)
        throw new Error(
          "This sign-in link has expired or was already used. Open a new link from the Vektor Docker installer.",
        );
      return true;
    }
    return (await fetch("/api/session", { credentials: "same-origin" })).ok;
  })());
}
