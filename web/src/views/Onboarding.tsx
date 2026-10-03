import { useCallback, useEffect, useState } from "react";
import type { AssistanceLevel, Settings } from "@teacher/shared";
import { ASSISTANCE_NAMES } from "@teacher/shared";
import TutorChat, { CLAUDE_CODE_URL } from "../components/TutorChat";
import type { TutorEvent } from "../api/tutorStream";
import { api, tutorAvailability, type Health, type TrackView } from "../api/client";
import type { Route } from "../App";

interface Recommendation {
  unitId: string;
  assistanceLevel: AssistanceLevel;
  reasoning: string;
}

interface Props {
  tracks: TrackView[];
  navigate: (r: Route) => void;
  /** the settings exactly as saved, so the app uses the level just chosen */
  onDone: (settings: Settings) => void;
}

export default function Onboarding({ tracks, navigate, onDone }: Props) {
  const [trackId, setTrackId] = useState<string | null>(null);
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [health, setHealth] = useState<Health | null>(null);

  // The placement chat is the centerpiece of first-run — check up front
  // whether the tutor can actually sign in, instead of letting the learner
  // greet a dead chat.
  useEffect(() => {
    api.health().then(setHealth).catch(() => {});
  }, []);

  const handleEvent = useCallback((e: TutorEvent) => {
    if (e.type === "recommendation") {
      setRec({
        unitId: e.unitId,
        assistanceLevel: e.assistanceLevel as AssistanceLevel,
        reasoning: e.reasoning,
      });
    }
  }, []);

  async function finish(unitId: string | null, level: AssistanceLevel) {
    const settings = (await fetch("/api/settings").then((r) => r.json())) as Settings;
    const next: Settings = { ...settings, onboarded: true, assistanceDefault: level };
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    onDone(next);
    const track = tracks.find((t) => t.id === trackId);
    const unit = track?.units.find((u) => u.id === unitId) ?? track?.units[0];
    const firstLesson = unit?.lessons[0];
    if (firstLesson) navigate({ view: "lesson", key: firstLesson.key });
    else if (track) navigate({ view: "track", trackId: track.id });
    else navigate({ view: "home" });
  }

  const { available: tutorAvailable, state: tutorState } = tutorAvailability(health);
  const notInstalled = tutorState === "not-installed";

  if (!trackId) {
    return (
      <div className="view-pad onboarding">
        <h1>Welcome to Rubberduck</h1>
        <p>
          Four language tracks, an AI tutor whose help level you control, and lessons with real goals.
          Pick where you'd like to begin — Python is the friendliest first language, but there's no wrong door.
        </p>
        <div className="track-grid">
          {tracks.map((t) => (
            <button key={t.id} className="track-card" onClick={() => setTrackId(t.id)}>
              <h2>{t.title}</h2>
              <p className="dim">{t.philosophy}</p>
            </button>
          ))}
        </div>
        <button className="back-link" onClick={() => void finish(null, 3)}>
          Skip setup — start from the very beginning
        </button>
      </div>
    );
  }

  return (
    <div className="view-pad onboarding">
      <h1>Quick placement chat</h1>
      {tutorAvailable === false ? (
        <div className="auth-warn-card">
          <strong>
            {notInstalled
              ? "The AI tutor needs Claude Code, which isn't installed here,"
              : "Claude Code is installed but isn't signed in,"}
          </strong>{" "}
          so the placement chat won't work yet.
          <p>
            To fix it:{" "}
            {notInstalled && (
              <>
                install{" "}
                <a href={CLAUDE_CODE_URL} target="_blank" rel="noreferrer">
                  Claude Code
                </a>
                , then{" "}
              </>
            )}
            run <code>claude setup-token</code> in a terminal and restart the app. Every lesson, run, and check still
            works without the tutor — you can start learning right away and redo setup later.
          </p>
          <button className="primary" onClick={() => void finish(null, 3)}>
            Skip placement — start from the very beginning
          </button>
        </div>
      ) : (
        <>
          <p className="dim">
            The tutor will ask a few short questions to find your starting point. Say hi to begin — or skip below.
          </p>
          <div className="placement-chat">
            <TutorChat
              lessonKey={`placement/${trackId}/interview`}
              level={3}
              hideSlider
              getContext={() => ({ files: {}, lastRun: null })}
              onEvent={handleEvent}
            />
          </div>
        </>
      )}
      {rec && (
        <div className="recommendation-card">
          <strong>Recommended start:</strong> unit <code>{rec.unitId}</code> with assistance level{" "}
          {rec.assistanceLevel} ({ASSISTANCE_NAMES[rec.assistanceLevel]})
          <p className="dim small">{rec.reasoning}</p>
          <button className="primary" onClick={() => void finish(rec.unitId, rec.assistanceLevel)}>
            Sounds good — let's go
          </button>
        </div>
      )}
      <button className="back-link" onClick={() => void finish(null, 5)}>
        Skip — start from the very beginning with full guidance
      </button>
    </div>
  );
}
