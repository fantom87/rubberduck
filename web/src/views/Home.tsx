import { useCallback, useEffect, useState } from "react";
import type { NextStep, PracticeSummary } from "@teacher/shared";
import { api, type CurriculumResponse, type TrackView } from "../api/client";
import ProgressBar from "../components/ProgressBar";
import { practiceLine } from "../practice";
import type { Route } from "../App";

function trackStats(track: TrackView) {
  let done = 0;
  let authored = 0;
  for (const u of track.units) {
    const projects = u.projects ?? [];
    authored += u.lessons.length + projects.length;
    done += u.lessons.filter((l) => l.completedAt).length + projects.filter((p) => p.completedAt).length;
  }
  return { done, authored };
}

const NEXT_LABEL: Record<NextStep["kind"], string> = {
  resume: "Pick up where you left off",
  next: "Next up",
  start: "Start here",
};

/** The welcome-back line: where they were, never how long they were gone. */
function welcomeLine(next: NextStep | null, practice: PracticeSummary | null): string | null {
  if (!next?.last) return null;
  const where = next.last.completed
    ? `Last time you finished “${next.last.title}”.`
    : `Last time you were working on “${next.last.title}”.`;
  const longGap = (practice?.daysSinceLast ?? 0) >= 7;
  return longGap ? `${where} No catching up needed, just carry on from here.` : where;
}

interface Props {
  navigate: (r: Route) => void;
  /** start a 10-minute session and open this lesson */
  onStartSession: (key: string) => void;
}

export default function Home({ navigate, onStartSession }: Props) {
  const [data, setData] = useState<CurriculumResponse | null>(null);
  const [practice, setPractice] = useState<PracticeSummary | null>(null);
  const [next, setNext] = useState<NextStep | null | undefined>(undefined);
  // Kept apart from next === null, which means "everything is done". A
  // failure must never show the celebration.
  const [nextFailed, setNextFailed] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    setError(false);
    setNextFailed(false);
    api.curriculum().then(setData).catch(() => setError(true));
    api.progress().then((p) => setPractice(p.practice ?? null)).catch(() => {});
    api
      .next()
      .then(setNext)
      .catch(() => {
        setNext(null);
        setNextFailed(true);
      });
  }, []);

  useEffect(load, [load]);

  if (error && !data) {
    return (
      <div className="view-pad">
        <h1>Can't reach the local server</h1>
        <p className="dim">The app's local server isn't answering — it may have stopped.</p>
        <button className="primary" onClick={load}>
          Retry
        </button>
      </div>
    );
  }
  if (!data || next === undefined) return <div className="view-pad">Loading…</div>;

  const ready = data.tracks.filter((t) => trackStats(t).authored > 0);
  const later = data.tracks.filter((t) => trackStats(t).authored === 0);
  const firstTime = !nextFailed && !next?.last && (practice?.totalDays ?? 0) === 0;
  const welcome = welcomeLine(next, practice);

  return (
    <div className="view-pad home">
      <h1>{firstTime ? "Let's start" : "Welcome back"}</h1>
      {welcome && <p className="welcome-line">{welcome}</p>}

      {nextFailed ? (
        <p className="welcome-line dim">Pick a track below to carry on.</p>
      ) : next ? (
        <section className="next-card" aria-labelledby="next-title">
          <div className="next-label">{NEXT_LABEL[next.kind]}</div>
          <h2 id="next-title" className="next-title">
            {next.title}
          </h2>
          <p className="dim small">
            {next.projectTitle ? `${next.projectTitle} · ` : ""}
            {next.trackTitle} · about {next.estMinutes} min
            {next.hasDraft ? " · your code is saved" : ""}
          </p>
          <div className="next-actions">
            <button className="primary next-go" onClick={() => navigate({ view: "lesson", key: next.key })}>
              ▶ {next.kind === "resume" ? "Pick up" : "Start"}
            </button>
            <button className="next-quick" onClick={() => onStartSession(next.key)}>
              ⏱ Just 10 minutes
            </button>
          </div>
        </section>
      ) : (
        <section className="next-card">
          <h2 className="next-title">You've finished every lesson there is. 🎉</h2>
          <p className="dim small">The Playground is always open, and a custom lesson is one click away on any track.</p>
          <div className="next-actions">
            <button className="primary" onClick={() => navigate({ view: "playground" })}>
              Open the Playground
            </button>
          </div>
        </section>
      )}

      {practice && <p className="practice-line">{practiceLine(practice)}</p>}

      <h2 className="tracks-heading">Or choose a track</h2>
      <div className="track-grid">
        {ready.map((t) => {
          const s = trackStats(t);
          return (
            <button key={t.id} className="track-card" onClick={() => navigate({ view: "track", trackId: t.id })}>
              <h3>{t.title}</h3>
              <p className="dim">{t.philosophy}</p>
              <ProgressBar done={s.done} total={s.authored} />
              <p className="dim small">{s.authored} lessons</p>
            </button>
          );
        })}
      </div>
      {later.length > 0 && (
        <p className="dim small coming-later">
          Coming later:{" "}
          {later.map((t, i) => (
            <span key={t.id}>
              {i > 0 && ", "}
              <button className="link-btn" onClick={() => navigate({ view: "track", trackId: t.id })}>
                {t.title}
              </button>
            </span>
          ))}
        </p>
      )}
      {data.errors.length > 0 && (
        <div className="content-errors">
          <strong>Content problems:</strong>
          <ul>
            {data.errors.map((e, i) => (
              <li key={i}>
                <code>{e.file}</code>: {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
