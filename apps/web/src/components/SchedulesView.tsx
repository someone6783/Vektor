import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Channel,
  JobRun,
  Profile,
  ScheduledJob,
  SchedulerState,
  SchedulePreview,
  CreateJob,
} from "@vektor/shared";
import type { ApiClient } from "../lib/api";

function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
function when(value: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function JobEditor({
  client,
  job,
  profiles,
  channels,
  onSaved,
  onClose,
}: {
  client: ApiClient;
  job: ScheduledJob | null;
  profiles: Profile[];
  channels: Channel[];
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(job?.name ?? "");
  const [schedule, setSchedule] = useState(job?.schedule ?? "weekdays at 9am");
  const [timezone, setTimezone] = useState(job?.timezone ?? localTimezone());
  const [profileId, setProfileId] = useState(job?.profileId ?? profiles[0]?.id ?? "");
  const [channelId, setChannelId] = useState(job?.channelId ?? channels[0]?.id ?? "");
  const [prompt, setPrompt] = useState(job?.prompt ?? "");
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
  const [catchUp, setCatchUp] = useState(job?.catchUp ?? false);
  const [includeHistory, setIncludeHistory] = useState(job?.includeHistory ?? false);
  const [allowTruncation, setAllowTruncation] = useState(job?.allowTruncation ?? false);
  const [browserAccess, setBrowserAccess] = useState<"off" | "observe" | "interactive">(
    job?.browserAccess ?? "off",
  );
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  useEffect(() => {
    let active = true;
    setPreview(null);
    setPreviewError(null);
    const timer = setTimeout(() => {
      void client
        .previewSchedule(schedule, timezone)
        .then((result) => {
          if (active) setPreview(result);
        })
        .catch((error) => {
          if (active) setPreviewError(error.message);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, schedule, timezone]);
  const save = async () => {
    if (!preview || !name.trim() || !prompt.trim()) return;
    setWorking(true);
    setError(null);
    const input: CreateJob = {
      name,
      schedule,
      timezone,
      profileId,
      channelId,
      prompt,
      enabled,
      catchUp,
      includeHistory,
      allowTruncation: includeHistory && allowTruncation,
      browserAccess,
    };
    try {
      if (job) await client.updateJob(job.id, input);
      else await client.createJob(input);
      await onSaved();
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to save job.");
    } finally {
      setWorking(false);
    }
  };
  const fieldClass = "mt-1 w-full rounded border border-white/15 bg-slate-950 px-3 py-2 text-sm";
  return (
    <form
      aria-label={job ? "Edit scheduled job" : "Create scheduled job"}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="mb-5 rounded-xl border border-emerald-400/20 bg-slate-900 p-4"
    >
      <h2 className="mb-3 font-semibold">{job ? "Edit job" : "New recurring job"}</h2>
      <label className="block text-xs text-slate-400">
        Job name
        <input
          aria-label="Job name"
          maxLength={100}
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={fieldClass}
        />
      </label>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="text-xs text-slate-400">
          Schedule
          <input
            aria-label="Schedule"
            required
            value={schedule}
            onChange={(event) => setSchedule(event.target.value)}
            className={fieldClass}
            placeholder="weekdays at 9am or 0 9 * * 1-5"
          />
        </label>
        <label className="text-xs text-slate-400">
          Time zone
          <input
            aria-label="Time zone"
            required
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            className={fieldClass}
            list="schedule-timezones"
          />
          <datalist id="schedule-timezones">
            {[
              "UTC",
              "Australia/Perth",
              "Australia/Sydney",
              "America/New_York",
              "Europe/London",
              "Asia/Tokyo",
            ].map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </label>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        Five cron fields (minute, hour, day, month, weekday), or friendly input: hourly, daily at
        14:00, weekdays at 9am, weekly on monday at 9am, every 15 minutes.
      </p>
      {previewError ? (
        <p role="alert" className="mt-2 text-xs text-rose-300">
          {previewError}
        </p>
      ) : preview ? (
        <details open className="mt-3 rounded bg-slate-950 p-3 text-xs">
          <summary>
            Next runs in {preview.timezone} · <code>{preview.cron}</code>
          </summary>
          <ul className="mt-2 space-y-1">
            {preview.nextRuns.map((date) => (
              <li key={date}>
                <time dateTime={date} title={date}>
                  {when(date, preview.timezone)}
                </time>
                <span className="ml-2 text-[10px] text-slate-500">{date}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[10px] text-slate-500">{preview.explanation}</p>
        </details>
      ) : (
        <p className="mt-2 text-xs text-slate-500">Checking schedule…</p>
      )}
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="text-xs text-slate-400">
          Profile
          <select
            aria-label="Job profile"
            value={profileId}
            onChange={(event) => setProfileId(event.target.value)}
            className={fieldClass}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} · {profile.terminalMode}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-400">
          Deliver into
          <select
            aria-label="Delivery channel"
            value={channelId}
            onChange={(event) => setChannelId(event.target.value)}
            className={fieldClass}
          >
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.kind === "dm" ? "@" : "#"}
                {channel.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="mt-3 block text-xs text-slate-400">
        Prompt
        <textarea
          aria-label="Job prompt"
          required
          rows={4}
          maxLength={100000}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          className={fieldClass}
        />
      </label>
      <label className="mt-3 block text-xs text-slate-400">
        Declared browser capability
        <select
          aria-label="Job browser access"
          value={browserAccess}
          onChange={(event) => setBrowserAccess(event.target.value as typeof browserAccess)}
          className={fieldClass}
        >
          <option value="off">Off</option>
          <option value="observe">Observation only</option>
          <option value="interactive">Interactive · waits for human approvals</option>
        </select>
      </label>
      <p className="mt-2 text-xs text-slate-500">
        This declaration can only reduce the profile’s browser permissions. Interactive scheduled
        runs pause for approvals; they do not assume unattended consent.
      </p>
      <div className="mt-3 space-y-2 text-xs text-slate-300">
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enable recurring schedule
        </label>
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={catchUp}
            onChange={(event) => setCatchUp(event.target.checked)}
          />
          Catch up missed runs once after downtime
        </label>
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={includeHistory}
            onChange={(event) => setIncludeHistory(event.target.checked)}
          />
          Include recent channel history
        </label>
        {includeHistory ? (
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={allowTruncation}
              onChange={(event) => setAllowTruncation(event.target.checked)}
            />
            Allow older history to be omitted when needed for context
          </label>
        ) : null}
      </div>
      <p className="mt-3 text-[11px] leading-5 text-slate-500">
        Uses the current profile and its terminal permissions. Attachments are excluded. Catch-up
        coalesces missed occurrences into one attempt; overlapping or busy-channel runs are skipped.
        Full-access commands still wait for approval in the runtime bar and can time out.
        Pausing/deleting stops future firings; cancel an active run separately.
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-xs text-rose-300">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex gap-3">
        <button
          disabled={
            working || !preview || !name.trim() || !prompt.trim() || !profileId || !channelId
          }
          type="submit"
          className="rounded bg-emerald-400 px-4 py-2 text-xs font-semibold text-slate-950 disabled:opacity-40"
        >
          {working ? "Saving…" : "Save job"}
        </button>
        <button type="button" onClick={onClose} className="px-3 text-xs text-slate-400">
          Close editor
        </button>
      </div>
    </form>
  );
}

function JobHistory({
  client,
  job,
  onOpenChannel,
}: {
  client: ApiClient;
  job: ScheduledJob;
  onOpenChannel: (id: string) => void;
}) {
  const [executions, setExecutions] = useState<JobRun[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cursorLoaded = useRef(false);
  useEffect(() => {
    let active = true;
    const update = async () => {
      try {
        const result = await client.jobHistory(job.id);
        if (active) {
          setExecutions((value) => [
            ...result.executions,
            ...value.filter((item) => !result.executions.some((next) => next.id === item.id)),
          ]);
          if (!cursorLoaded.current) {
            setBefore(result.nextBefore);
            cursorLoaded.current = true;
          }
          setError(null);
        }
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : "Unable to load history.");
      }
    };
    void update();
    const timer = setInterval(() => void update(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, job.id]);
  const more = async () => {
    if (!before) return;
    try {
      const result = await client.jobHistory(job.id, before);
      setExecutions((value) => [...value, ...result.executions]);
      setBefore(result.nextBefore);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to load history.");
    }
  };
  return (
    <section
      aria-label={`Run history for ${job.name}`}
      className="mt-4 border-t border-white/10 pt-3"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Run history</h3>
        <button
          type="button"
          onClick={() => onOpenChannel(job.channelId)}
          className="text-xs text-emerald-300"
        >
          Open delivery channel
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {!executions.length ? (
        <p className="mt-2 text-xs text-slate-500">No executions yet.</p>
      ) : (
        <ol className="mt-3 space-y-2">
          {executions.map((execution) => (
            <li key={execution.id} className="rounded bg-slate-950 p-2 text-xs">
              <p>
                {execution.awaitingApproval ? "Waiting for approval" : execution.status} ·{" "}
                {execution.source} · {when(execution.scheduledFor, job.timezone)}
              </p>
              {execution.error ? <p className="mt-1 text-amber-200">{execution.error}</p> : null}
              {execution.runId ? (
                <p className="mt-1 font-mono text-[10px] text-slate-500">Run {execution.runId}</p>
              ) : null}
              {execution.status === "running" && execution.runId ? (
                <button
                  type="button"
                  onClick={() => {
                    void client
                      .cancelRun(execution.runId!)
                      .catch((error) => setError(error.message));
                  }}
                  className="mt-1 text-rose-300"
                >
                  Cancel scheduled run
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {before ? (
        <button type="button" onClick={() => void more()} className="mt-2 text-xs text-slate-400">
          Earlier executions
        </button>
      ) : null}
    </section>
  );
}

export function SchedulesView({
  client,
  profiles,
  channels,
  onOpenChannel,
}: {
  client: ApiClient;
  profiles: Profile[];
  channels: Channel[];
  onOpenChannel: (id: string) => void;
}) {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [state, setState] = useState<SchedulerState | null>(null);
  const [editor, setEditor] = useState<ScheduledJob | "new" | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const [jobs, state] = await Promise.all([
      client.listJobs(showDeleted),
      client.schedulerState(),
    ]);
    setJobs(jobs);
    setState(state);
  }, [client, showDeleted]);
  useEffect(() => {
    let active = true;
    const update = async () => {
      try {
        const [jobs, state] = await Promise.all([
          client.listJobs(showDeleted),
          client.schedulerState(),
        ]);
        if (active) {
          setJobs(jobs);
          setState(state);
        }
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : "Unable to load schedules.");
      }
    };
    void update();
    const timer = setInterval(() => void update(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, showDeleted]);
  const action = async (callback: () => Promise<unknown>) => {
    setWorking(true);
    setError(null);
    try {
      await callback();
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Job action failed.");
    } finally {
      setWorking(false);
    }
  };
  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <header className="mb-5 flex flex-wrap items-center gap-3">
          <div>
            <h1 className="text-xl font-semibold">Schedules</h1>
            <p className="mt-1 text-xs text-slate-500">
              Recurring profile runs delivered into your channels.
            </p>
          </div>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              disabled={working || !state?.enabled}
              onClick={() =>
                void action(() =>
                  state?.paused ? client.resumeScheduler() : client.pauseScheduler(),
                )
              }
              className="rounded border border-white/20 px-3 py-2 text-xs disabled:opacity-40"
            >
              {state?.paused ? "Resume scheduler" : "Pause scheduler"}
            </button>
            <button
              type="button"
              onClick={() => setEditor("new")}
              disabled={!profiles.length || !channels.length}
              className="rounded bg-emerald-400 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-40"
            >
              New job
            </button>
          </div>
        </header>
        {!state?.enabled && state ? (
          <p className="mb-3 text-xs text-amber-200">
            The scheduler is disabled by backend configuration. Jobs can be edited but cannot
            execute.
          </p>
        ) : null}
        {state?.emergencyStopped ? (
          <p className="mb-3 text-xs text-rose-300">
            Emergency stop is active. No scheduled or manual job can start.
          </p>
        ) : null}
        {state?.paused ? (
          <p className="mb-3 text-xs text-amber-200">
            Scheduler paused. Due occurrences are skipped; resume schedules future work without
            replaying the paused interval.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mb-4 text-xs text-rose-300">
            {error}
          </p>
        ) : null}
        {editor ? (
          <JobEditor
            key={editor === "new" ? "new" : editor.id}
            client={client}
            job={editor === "new" ? null : editor}
            profiles={profiles}
            channels={channels}
            onSaved={refresh}
            onClose={() => setEditor(null)}
          />
        ) : null}
        <label className="mb-4 flex gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(event) => setShowDeleted(event.target.checked)}
          />
          Show deleted jobs and their history
        </label>
        {!jobs.length ? (
          <p className="text-sm text-slate-500">
            No scheduled jobs yet. Create one to run a profile on a recurring schedule.
          </p>
        ) : (
          <div className="space-y-4">
            {jobs.map((job) => (
              <article
                key={job.id}
                className="rounded-xl border border-white/10 bg-slate-900/60 p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold">{job.name}</h2>
                  <span className="rounded bg-white/5 px-2 py-1 text-[10px] text-slate-400">
                    {job.deletedAt ? "Deleted" : job.enabled ? "Enabled" : "Paused"}
                  </span>
                  <span className="text-[10px] text-slate-500">
                    {profiles.find((profile) => profile.id === job.profileId)?.name ??
                      "Archived profile"}{" "}
                    →{" "}
                    {channels.find((channel) => channel.id === job.channelId)?.name ??
                      "Archived channel"}
                  </span>
                </div>
                <p className="mt-2 font-mono text-xs text-slate-400">
                  {job.cron} · {job.timezone}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Next: {job.nextRunAt ? when(job.nextRunAt, job.timezone) : "Not scheduled"}
                </p>
                {job.lastStatus ? (
                  <p className="mt-1 text-xs text-slate-500">
                    Last: {job.lastStatus}
                    {job.lastError ? ` · ${job.lastError}` : ""}
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-3 text-xs">
                  {!job.deletedAt ? (
                    <>
                      <button
                        type="button"
                        disabled={working}
                        onClick={() => setEditor(job)}
                        className="text-emerald-300"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={working}
                        onClick={() =>
                          void action(() => client.updateJob(job.id, { enabled: !job.enabled }))
                        }
                      >
                        {job.enabled ? "Pause job" : "Resume job"}
                      </button>
                      <button
                        type="button"
                        disabled={
                          working || !state?.enabled || state.paused || state.emergencyStopped
                        }
                        onClick={() => void action(() => client.runJob(job.id))}
                      >
                        Run now
                      </button>
                      <button
                        type="button"
                        disabled={working}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete '${job.name}'? Future firings stop; existing runs and history are retained.`,
                            )
                          )
                            void action(() => client.deleteJob(job.id));
                        }}
                        className="text-rose-300"
                      >
                        Delete job
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setHistory((value) => (value === job.id ? null : job.id))}
                  >
                    {history === job.id ? "Hide history" : "Inspect history"}
                  </button>
                </div>
                {history === job.id ? (
                  <JobHistory client={client} job={job} onOpenChannel={onOpenChannel} />
                ) : null}
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
