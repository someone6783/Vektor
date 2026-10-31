import { HealthCard } from "./components/HealthCard";
import { StreamDemo } from "./components/StreamDemo";

const plannedNavigation = [
  { label: "Chat", phase: "Phase 2" },
  { label: "Profiles", phase: "Phase 2" },
  { label: "Settings", phase: "Phase 2" },
];

export default function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-400 font-bold text-slate-950">
              V
            </div>
            <div>
              <div className="text-sm font-semibold tracking-wide">Vektor</div>
              <div className="text-xs text-slate-400">Local AI workspace</div>
            </div>
          </div>

          <nav className="ml-auto hidden items-center gap-1 md:flex" aria-label="Planned sections">
            {plannedNavigation.map((item) => (
              <span
                key={item.label}
                className="cursor-not-allowed rounded-lg px-3 py-2 text-sm text-slate-500"
                title={`${item.label} arrives in ${item.phase}`}
              >
                {item.label}
                <span className="ml-2 rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500">
                  {item.phase}
                </span>
              </span>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-6 py-10 lg:grid-cols-[1fr_1.15fr]">
        <section className="space-y-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-400">
              Phase 1 · Foundation
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight">
              A local workspace for agents that can actually do things.
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-6 text-slate-400">
              Profiles, channels, streamed responses, files, a permissioned terminal, and scheduled
              runs. The foundation is live: API, database, auth, and the event stream are wired up.
            </p>
          </div>

          <HealthCard />

          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm text-slate-400">
            <h2 className="text-sm font-medium text-slate-200">What lands next</h2>
            <ul className="mt-3 space-y-2">
              <li>Phase 2 · Profiles, channels, streamed Markdown chat</li>
              <li>Phase 3 · Files, attachments, and context controls</li>
              <li>Phase 4 · Terminal permissions and run controls</li>
            </ul>
          </div>
        </section>

        <StreamDemo />
      </main>

      <footer className="border-t border-white/10 px-6 py-5 text-center text-xs text-slate-500">
        Vektor v0.1.0 · data stays on this machine
      </footer>
    </div>
  );
}
