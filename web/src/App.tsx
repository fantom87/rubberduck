import { useCallback, useEffect, useRef, useState } from "react";
import type { PracticeSummary, Settings } from "@teacher/shared";
import Home from "./views/Home";
import Track from "./views/Track";
import LessonView from "./views/Lesson";
import Playground from "./views/Playground";
import Docs from "./views/Docs";
import Stats from "./views/Stats";
import SettingsView from "./views/Settings";
import Onboarding from "./views/Onboarding";
import DocsDrawer from "./components/DocsDrawer";
import SessionTimer from "./components/SessionTimer";
import { PRACTICE_EVENT, endLessonActivity } from "./activity";
import { practiceToast } from "./practice";
import { CLAUDE_CODE_URL } from "./components/TutorChat";
import { API_OFFLINE_EVENT, API_ONLINE_EVENT, api, tutorAvailability, type TutorState, type TrackView } from "./api/client";
import { SettingsContext } from "./settingsContext";

export type Route =
  | { view: "home" }
  | { view: "track"; trackId: string }
  | { view: "lesson"; key: string }
  | { view: "playground" }
  | { view: "docs" }
  | { view: "stats" }
  | { view: "settings" };

function focusEditor() {
  document.querySelector<HTMLElement>(".cm-content")?.focus();
}

// ---------- the "just 10 minutes" session ----------

const SESSION_MINUTES = 10;
const SESSION_KEY = "session";

// A session belongs to one sitting. sessionStorage survives a reload but not
// closing the app, so the countdown can't run on while the app is shut and
// then greet the next launch with "That's your 10 minutes".
function storedSession(): { endsAt: number } | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null") as { endsAt?: unknown } | null;
    if (!s || typeof s.endsAt !== "number" || Date.now() >= s.endsAt) return null;
    return { endsAt: s.endsAt };
  } catch {
    return null;
  }
}

function saveSession(s: { endsAt: number } | null): void {
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // storage unavailable — the session still runs for this visit
  }
}

const SESSION_DONE_TEXT = `⏱ That's your ${SESSION_MINUTES} minutes. A good place to stop, or keep going if you're in the flow.`;

export default function App() {
  // localStorage is only the pre-fetch paint hint — settings.json is the
  // single source of truth for the theme (the topbar toggle PUTs it below).
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem("theme") as "dark" | "light") ?? "dark",
  );
  const [route, setRoute] = useState<Route>(() => {
    try {
      return JSON.parse(localStorage.getItem("route") ?? "") as Route;
    } catch {
      return { view: "home" };
    }
  });
  const [practice, setPractice] = useState<PracticeSummary | null>(null);
  const practiceRef = useRef<PracticeSummary | null>(null);
  const [session, setSession] = useState(storedSession);
  const [sessionDone, setSessionDone] = useState(false);
  // The server call that counts a finished session's day; Stop here and Keep
  // going wait for it, so their scoreboard read includes it.
  const sessionRecorded = useRef<Promise<unknown>>(Promise.resolve());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerDoc, setDrawerDoc] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [bootFailed, setBootFailed] = useState(false);
  const [tracks, setTracks] = useState<TrackView[]>([]);
  const [confetti, setConfetti] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const [offline, setOffline] = useState(false);
  const [tutorState, setTutorState] = useState<TutorState>("unknown");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("route", JSON.stringify(route));
  }, [route]);

  const boot = useCallback(() => {
    setBootFailed(false);
    api
      .settings()
      .then((s) => {
        setSettings(s);
        setTheme(s.theme);
      })
      .catch(() => setBootFailed(true));
    api.curriculum().then((c) => setTracks(c.tracks)).catch(console.error);
    api.health().then((h) => setTutorState(tutorAvailability(h).state)).catch(() => {});
  }, []);

  useEffect(boot, [boot]);

  // The page can win the startup race against its own server (dev mode brings
  // both up together) — retry boot quietly for a few seconds before the
  // failure screen asks the human to click anything.
  useEffect(() => {
    if (!bootFailed) return;
    const timer = window.setTimeout(boot, 2000);
    return () => window.clearTimeout(timer);
  }, [bootFailed, boot]);

  // The api client fires these on network-level failures/successes.
  useEffect(() => {
    const onOffline = () => setOffline(true);
    const onOnline = () => setOffline(false);
    window.addEventListener(API_OFFLINE_EVENT, onOffline);
    window.addEventListener(API_ONLINE_EVENT, onOnline);
    return () => {
      window.removeEventListener(API_OFFLINE_EVENT, onOffline);
      window.removeEventListener(API_ONLINE_EVENT, onOnline);
    };
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 5000);
  }, []);

  /**
   * Re-read the scoreboard. With `announce`, say what changed: a day that
   * just counted, a weekly goal just met. `fallback` is said when nothing did.
   */
  const applyPractice = useCallback(
    (next: PracticeSummary, announce: boolean, fallback?: string) => {
      const prev = practiceRef.current;
      const message = announce && prev ? practiceToast(prev, next) : null;
      if (message ?? fallback) showToast((message ?? fallback)!);
      practiceRef.current = next;
      setPractice(next);
    },
    [showToast],
  );

  const refreshPractice = useCallback(
    (announce = false, fallback?: string) => {
      api
        .progress()
        .then((p) => {
          if (p.practice) applyPractice(p.practice, announce, fallback);
        })
        .catch(() => {});
    },
    [applyPractice],
  );

  useEffect(() => refreshPractice(), [refreshPractice]);

  // Every activity report brings the scoreboard back with it, so a day earned
  // by ten minutes of work (no lesson finished) is announced as it happens.
  useEffect(() => {
    const onPractice = (e: Event) => applyPractice((e as CustomEvent<PracticeSummary>).detail, true);
    window.addEventListener(PRACTICE_EVENT, onPractice);
    return () => window.removeEventListener(PRACTICE_EVENT, onPractice);
  }, [applyPractice]);

  const celebrate = useCallback(() => {
    refreshPractice(true);
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setConfetti(true);
      setTimeout(() => setConfetti(false), 1600);
    }
  }, [refreshPractice]);

  const startSession = useCallback(() => {
    const s = { endsAt: Date.now() + SESSION_MINUTES * 60_000 };
    saveSession(s);
    setSession(s);
    setSessionDone(false);
  }, []);

  const clearSession = useCallback(() => {
    saveSession(null);
    setSession(null);
    setSessionDone(false);
  }, []);

  // The countdown reached zero with the app open: the day counts (see
  // recordSessionComplete). Announced when the learner answers the banner.
  const handleSessionDone = useCallback(() => {
    setSessionDone(true);
    sessionRecorded.current = api.completeSession().catch(() => {});
  }, []);

  /** "Stop here": the draft and the last partial minute are saved, then home. */
  async function stopHere() {
    clearSession();
    await Promise.all([endLessonActivity(), sessionRecorded.current]);
    setRoute({ view: "home" });
    refreshPractice(true, "Saved. That's ten minutes done.");
  }

  async function keepGoing() {
    clearSession();
    await sessionRecorded.current;
    refreshPractice(true);
  }

  // Global shortcuts: Ctrl+D toggles docs (except inside the editor, where
  // CodeMirror's select-next-occurrence owns it), F1 opens docs, Alt+E jumps
  // to the editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F1") {
        e.preventDefault();
        setDrawerOpen(true);
        return;
      }
      if (e.altKey && !e.ctrlKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        focusEditor();
        return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === "d") {
        if (e.defaultPrevented) return;
        if (e.target instanceof Element && e.target.closest(".cm-editor")) return;
        e.preventDefault();
        setDrawerOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openDoc = useCallback((slug: string) => {
    setDrawerDoc(slug);
    setDrawerOpen(true);
  }, []);

  function applySettings(s: Settings) {
    setSettings(s);
    setTheme(s.theme);
  }

  function toggleTheme() {
    const next: "dark" | "light" = theme === "dark" ? "light" : "dark";
    setTheme(next);
    if (settings) {
      const updated = { ...settings, theme: next };
      setSettings(updated);
      // Persist so the toggle survives a restart; failure surfaces via the
      // offline banner rather than blocking the visual switch.
      api.saveSettings(updated).catch(() => {});
    }
  }

  const banners = (
    <>
      {sessionDone && (
        <div className="app-banner session-done">
          <span>{SESSION_DONE_TEXT}</span>
          <button className="primary" onClick={() => void stopHere()}>
            Stop here
          </button>
          <button onClick={() => void keepGoing()}>Keep going</button>
        </div>
      )}
      {offline && (
        <div className="app-banner" role="alert">
          <span>
            ⚠ Can't reach the local server — it may have stopped. If the problem persists, restart the app (or run{" "}
            <code>npm run start</code> in the project folder).
          </span>
          <button onClick={() => api.health().then(() => setOffline(false)).catch(() => {})}>Retry</button>
          <button aria-label="Dismiss server warning" onClick={() => setOffline(false)}>
            ✕
          </button>
        </div>
      )}
      {tutorState === "not-installed" && (
        <div className="app-banner" role="alert">
          <span>
            ⚠ The AI tutor runs on your own{" "}
            <a href={CLAUDE_CODE_URL} target="_blank" rel="noreferrer">
              Claude Code
            </a>
            , which isn't installed here. Install it, run <code>claude setup-token</code>, and restart the app. Lessons,
            runs, and checks still work without it.
          </span>
        </div>
      )}
      {tutorState === "not-logged-in" && (
        <div className="app-banner" role="alert">
          <span>
            ⚠ Claude Code is installed but isn't signed in, so the AI tutor is off. Run <code>claude setup-token</code>{" "}
            in a terminal, then restart the app. Lessons, runs, and checks still work without it.
          </span>
        </div>
      )}
    </>
  );

  if (bootFailed && !settings) {
    return (
      <div className="app">
        <main className="main">
          <div className="view-pad">
            <h1>Can't reach the local server</h1>
            <p className="dim">
              The app's local server isn't answering. If you launched the desktop app, try closing and reopening it;
              otherwise run <code>npm run start</code> in the project folder and check its output.
            </p>
            <button className="primary" onClick={boot}>
              Retry
            </button>
          </div>
        </main>
      </div>
    );
  }

  // Nothing renders until settings resolve — prevents the full app flashing
  // (clickable, even) before first-run onboarding appears.
  if (!settings) return null;

  if (!settings.onboarded) {
    return (
      <SettingsContext.Provider value={settings}>
        <div className="app">
          {banners}
          <main className="main">
            <Onboarding
              tracks={tracks}
              navigate={setRoute}
              onDone={applySettings}
            />
          </main>
        </div>
      </SettingsContext.Provider>
    );
  }

  const navBtn = (r: Route, label: string) => (
    <button
      className={`nav-btn ${route.view === r.view ? "active" : ""}`}
      onClick={() => setRoute(r)}
    >
      {label}
    </button>
  );

  return (
    <SettingsContext.Provider value={settings}>
      <div className="app">
        <a
          href="#editor"
          className="skip-link"
          onClick={(e) => {
            e.preventDefault();
            focusEditor();
          }}
        >
          Skip to editor (Alt+E)
        </a>
        <header className="topbar">
          <button className="title-btn" onClick={() => setRoute({ view: "home" })}>
            <span className="title">Rubberduck</span>
          </button>
          {navBtn({ view: "playground" }, "Playground")}
          {navBtn({ view: "docs" }, "Docs")}
          {navBtn({ view: "stats" }, "Stats")}
          <span className="spacer" />
          {session && !sessionDone ? (
            <SessionTimer endsAt={session.endsAt} onDone={handleSessionDone} onCancel={clearSession} />
          ) : (
            !sessionDone && (
              <button className="session-start" title={`Start a ${SESSION_MINUTES}-minute session`} onClick={startSession}>
                ⏱ {SESSION_MINUTES} min
              </button>
            )
          )}
          {practice && practice.weekStreak > 0 ? (
            <span
              className="streak-chip"
              title={`${practice.weekStreak} week${practice.weekStreak === 1 ? "" : "s"} in a row with your goal of ${practice.weeklyGoal} days met`}
            >
              🔥 {practice.weekStreak}
            </span>
          ) : (
            practice &&
            practice.daysThisWeek > 0 && (
              <span className="streak-chip" title={`${practice.daysThisWeek} of ${practice.weeklyGoal} practice days this week`}>
                📅 {practice.daysThisWeek}/{practice.weeklyGoal}
              </span>
            )
          )}
          <button aria-label="Open documentation drawer (Ctrl+D)" title="Docs drawer (Ctrl+D)" onClick={() => setDrawerOpen(true)}>
            📖
          </button>
          <button aria-label="Toggle color theme" onClick={toggleTheme}>
            {theme === "dark" ? "☀" : "🌙"}
          </button>
          <button aria-label="Settings" onClick={() => setRoute({ view: "settings" })}>
            ⚙
          </button>
        </header>
        {banners}
        <main className="main">
          {route.view === "home" && (
            <Home
              navigate={setRoute}
              onStartSession={(key) => {
                startSession();
                setRoute({ view: "lesson", key });
              }}
            />
          )}
          {route.view === "track" && <Track trackId={route.trackId} navigate={setRoute} />}
          {route.view === "lesson" && (
            <LessonView
              lessonKey={route.key}
              theme={theme}
              navigate={setRoute}
              onProgressChange={celebrate}
              onOpenDoc={openDoc}
            />
          )}
          {route.view === "playground" && <Playground theme={theme} />}
          {route.view === "docs" && (
            <div className="view-pad docs-fullpage">
              <Docs />
            </div>
          )}
          {route.view === "stats" && <Stats />}
          {route.view === "settings" && (
            <SettingsView
              onSettingsChange={applySettings}
              // After the save lands, not before: the scoreboard is computed
              // from the goal on disk.
              onSaved={() => refreshPractice()}
            />
          )}
        </main>
        <DocsDrawer open={drawerOpen} initial={drawerDoc} onClose={() => setDrawerOpen(false)} />
        {toast && (
          <div className="toast" aria-hidden="true">
            {toast}
          </div>
        )}
        {/* One live region, always mounted. Screen readers announce changes to
            an existing region; one that appears with its text already inside
            is often read out by nobody. */}
        <div className="sr-only" role="status">
          {toast ?? (sessionDone ? SESSION_DONE_TEXT : "")}
        </div>
        {confetti && (
          <div className="confetti" aria-hidden="true">
            {Array.from({ length: 24 }, (_, i) => (
              <span key={i} style={{ left: `${(i * 41) % 100}%`, animationDelay: `${(i % 8) * 0.08}s` }}>
                {["🎉", "⭐", "✨", "🎊"][i % 4]}
              </span>
            ))}
          </div>
        )}
      </div>
    </SettingsContext.Provider>
  );
}
