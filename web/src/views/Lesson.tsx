import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistanceLevel, CheckResult, Lesson, RunResult } from "@teacher/shared";
import { buildJsTestProgram, buildPyTestProgram, evaluateStdoutCheck, evaluateTestsCheck, extractTestEvents } from "@teacher/shared";
import EditorPane from "../components/EditorPane";
import OutputPane from "../components/OutputPane";
import GoalChecklist from "../components/GoalChecklist";
import HistoryMenu from "../components/HistoryMenu";
import TutorChat from "../components/TutorChat";
import type { TutorEvent } from "../api/tutorStream";
import { runJs } from "../runners/jsWorkerRunner";
import { runPython, warmPyodide, onPyodideStatus, isPyodideWarm } from "../runners/pyodideRunner";
import { runSql, warmSqlJs } from "../runners/sqlRunner";
import { buildSrcdoc } from "../runners/htmlPreview";
import { api } from "../api/client";
import type { ProjectContext } from "../api/client";
import { useTutorStatus } from "../api/useTutorStatus";
import { useSettings } from "../settingsContext";
import { renderMarkdown } from "../md";
import type { Route } from "../App";

interface Props {
  lessonKey: string;
  theme: "dark" | "light";
  navigate: (r: Route) => void;
  onProgressChange: () => void;
  onOpenDoc: (slug: string) => void;
}

// ---------- per-lesson assistance level (survives navigation) ----------

const ASSIST_KEY = "assistanceLevels";

function storedAssistLevel(lessonKey: string): AssistanceLevel | null {
  try {
    const map = JSON.parse(localStorage.getItem(ASSIST_KEY) ?? "{}") as Record<string, unknown>;
    const v = Number(map[lessonKey]);
    return Number.isInteger(v) && v >= 1 && v <= 5 ? (v as AssistanceLevel) : null;
  } catch {
    return null;
  }
}

function storeAssistLevel(lessonKey: string, level: AssistanceLevel): void {
  try {
    const map = JSON.parse(localStorage.getItem(ASSIST_KEY) ?? "{}") as Record<string, unknown>;
    map[lessonKey] = level;
    localStorage.setItem(ASSIST_KEY, JSON.stringify(map));
  } catch {
    // storage unavailable — level lives for this session only
  }
}

// ---------- pane sizes (persisted to settings.layout.paneSizes) ----------

/** Latest sizes this session — survives remounts while the settings PUT is in flight. */
let cachedPaneSizes: number[] | null = null;

function validPaneSizes(sizes: unknown): number[] | null {
  if (!Array.isArray(sizes) || sizes.length !== 3) return null;
  if (!sizes.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 10 && n <= 80)) return null;
  const sum = sizes.reduce((a, b) => a + b, 0);
  return sum > 95 && sum < 105 ? sizes : null;
}

// ---------- instant preview checks (browser runs) ----------

/** Browser-side "preview" verdicts for stdout/tests checks after a Run, via the
 *  same shared engine the server uses. The server's Check stays canonical. */
async function computePreviewChecks(
  lesson: Lesson,
  files: Record<string, string>,
  run: RunResult,
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const spec of lesson.checks) {
    if (spec.type === "stdout") {
      if (spec.stdin) continue; // browser runs can't feed stdin — leave to the server
      out.push(evaluateStdoutCheck(spec, run));
    } else if (spec.type === "tests") {
      const testSource = lesson.testFiles[spec.testFile];
      if (!testSource) continue;
      const userCode = files[spec.entry] ?? "";
      const nonce = Math.random().toString(16).slice(2);
      let testRun: RunResult;
      if (lesson.language === "javascript") {
        testRun = await runJs(buildJsTestProgram(userCode, testSource, nonce));
      } else if (lesson.language === "python") {
        testRun = await runPython(buildPyTestProgram(userCode, testSource, nonce));
      } else {
        continue;
      }
      const [, events] = extractTestEvents(testRun.stdout, nonce);
      out.push(evaluateTestsCheck(spec, { ...testRun, events }));
    }
  }
  return out;
}

// ---------- ARIA tabs keyboard pattern ----------

export function tabListKeyDown(
  e: React.KeyboardEvent<HTMLButtonElement>,
  index: number,
  count: number,
  select: (i: number) => void,
): void {
  let next: number | null = null;
  if (e.key === "ArrowRight") next = (index + 1) % count;
  else if (e.key === "ArrowLeft") next = (index - 1 + count) % count;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = count - 1;
  if (next === null) return;
  e.preventDefault();
  select(next);
  (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
}

export default function LessonView({ lessonKey, theme, navigate, onProgressChange, onOpenDoc }: Props) {
  const settings = useSettings();
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [activeFile, setActiveFile] = useState("");
  const [editorGen, setEditorGen] = useState(0);
  const [result, setResult] = useState<RunResult | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResults, setCheckResults] = useState<CheckResult[] | null>(null);
  const [previewChecks, setPreviewChecks] = useState<CheckResult[] | null>(null);
  const [completed, setCompleted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<AssistanceLevel>(3);
  const [revealedHints, setRevealedHints] = useState<number[]>([]);
  const [pendingTutorMsg, setPendingTutorMsg] = useState<string | null>(null);
  // Undefined until /api/health answers — the panes render optimistically and
  // only switch to their offline forms once we know the tutor is unreachable.
  const { available: tutorAvailable, state: tutorState } = useTutorStatus();
  const [paneSizes, setPaneSizes] = useState<number[]>(
    () => cachedPaneSizes ?? validPaneSizes(settings.layout?.paneSizes) ?? [30, 45, 25],
  );
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const paneDragging = useRef(false);
  const filesRef = useRef(files);
  filesRef.current = files;
  const resultRef = useRef(result);
  resultRef.current = result;
  const lessonKeyRef = useRef(lessonKey);
  lessonKeyRef.current = lessonKey;
  const [project, setProject] = useState<ProjectContext | null>(null);
  /**
   * Where the editor's contents are saved. For an ordinary lesson that's the
   * lesson key; for a project stage it's the PROJECT key, which is the whole
   * trick behind carrying the learner's own code from one stage to the next.
   * Completion stays keyed per stage.
   */
  const draftKeyRef = useRef(lessonKey);
  const paneSizesRef = useRef(paneSizes);
  paneSizesRef.current = paneSizes;

  useEffect(() => {
    let cancelled = false;
    setLesson(null);
    setResult(null);
    setPreview(null);
    setCheckResults(null);
    setPreviewChecks(null);
    setNotice(null);
    setRevealedHints([]);
    (async () => {
      try {
        const l = await api.lesson(lessonKey);
        // The draft key depends on what we just loaded, so it can't be
        // resolved before the fetch: a stage saves against its project.
        draftKeyRef.current = l.stage?.projectKey ?? lessonKey;
        const draft = await api.draft(draftKeyRef.current).catch(() => ({ files: null }));
        if (cancelled) return;
        setLesson(l);
        setProject(l.project ?? null);
        const initial = draft.files ?? l.starterFiles;
        setFiles(initial);
        setActiveFile(l.files[0]?.path ?? "");
        localStorage.setItem("lastLessonKey", lessonKey);
        localStorage.setItem("lastLessonTitle", l.title);
        if (l.language === "html-css") setPreview(buildSrcdoc(initial));
        if (l.language === "python" && l.runner === "browser") {
          warmPyodide();
          if (!isPyodideWarm()) setNotice("Loading Python (one-time, ~13 MB)…");
        }
        if (l.language === "sql" && l.runner === "browser") warmSqlJs();
        const [progress, freshSettings] = await Promise.all([
          api.progress(),
          api.settings().catch(() => null),
        ]);
        if (!cancelled) {
          setCompleted(Boolean(progress.lessons[lessonKey]?.completedAt));
          const lvl = storedAssistLevel(lessonKey) ?? ((freshSettings?.assistanceDefault ?? 3) as AssistanceLevel);
          setLevel(lvl);
          // Hand-holder/Instructor learners get the first baked hint up front.
          if (lvl >= 4 && (l.hints?.length ?? 0) > 0) setRevealedHints([0]);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    const offStatus = onPyodideStatus((phase) => {
      if (!cancelled && phase === "ready") setNotice(null);
    });
    return () => {
      cancelled = true;
      offStatus();
      // Flush (don't discard) a pending draft save: the last keystrokes before
      // "Next lesson"/Back must reach the server.
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        api.saveDraft(draftKeyRef.current, filesRef.current).catch(() => {});
      }
    };
  }, [lessonKey]);

  // Activity heartbeat: a minute of visible lesson time at a time. Feeds the
  // ≥15-minutes-a-day streak rule and per-lesson time-spent.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        api.reportActivity(60, lessonKey).catch(() => {});
      }
    }, 60_000);
    return () => clearInterval(timer);
  }, [lessonKey]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      api.saveDraft(draftKeyRef.current, filesRef.current).catch(console.error);
    }, 800);
  }, [lessonKey]);

  function handleChange(code: string) {
    setFiles((f) => {
      const next = { ...f, [activeFile]: code };
      if (lesson?.language === "html-css") setPreview(buildSrcdoc(next));
      return next;
    });
    scheduleSave();
  }

  /**
   * Replace the workspace with the canonical end-of-stage version.
   *
   * Every later stage builds on this one, so without a way out, one bad stage
   * ends the project. Confirmed explicitly because it overwrites their work,
   * and snapshotted first so History can undo it.
   */
  async function handleUseReference() {
    if (!lesson?.stage) return;
    const ok = window.confirm(
      `Replace your workspace with the finished version of "${lesson.title}"?\n\n` +
        `Your current code is saved to History first, so you can go back to it.`,
    );
    if (!ok) return;
    try {
      await fetch("/api/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId: lessonKey, files: filesRef.current, trigger: "run" }),
      });
      const { files: reference } = await api.stageSolution(lessonKey);
      setFiles(reference);
      setEditorGen((g) => g + 1); // force CodeMirror to take the new contents
      await api.saveDraft(draftKeyRef.current, reference);
      setNotice("Workspace replaced with this stage's reference. Your previous code is in History.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  function handleLevelChange(l: AssistanceLevel) {
    setLevel(l);
    storeAssistLevel(lessonKey, l);
  }

  async function handleRun() {
    if (!lesson || running) return;
    const entry = lesson.entry ?? lesson.files[0].path;
    setRunning(true);
    setNotice(null);
    try {
      if (lesson.runner === "local") {
        setResult(await api.run(lessonKey, filesRef.current));
      } else if (lesson.language === "javascript" || lesson.language === "python" || lesson.language === "sql") {
        const run =
          lesson.language === "javascript"
            ? await runJs(filesRef.current[entry] ?? "")
            : lesson.language === "python"
              ? await runPython(filesRef.current[entry] ?? "")
              : await runSql(filesRef.current, entry);
        setResult(run);
        void fetch("/api/snapshots", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lessonId: lessonKey, files: filesRef.current, trigger: "run" }),
        });
        // Instant feedback on the goal checklist — dimmed "preview" verdicts
        // until the server's Check confirms.
        const key = lessonKey;
        void computePreviewChecks(lesson, filesRef.current, run)
          .then((p) => {
            if (p.length > 0 && lessonKeyRef.current === key) setPreviewChecks(p);
          })
          .catch(() => {});
      } else {
        // html-css: rebuild the live preview AND record the attempt/snapshot,
        // same as the other browser runners.
        setPreview(buildSrcdoc(filesRef.current));
        void fetch("/api/snapshots", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lessonId: lessonKey, files: filesRef.current, trigger: "run" }),
        });
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  async function handleCheck() {
    if (!lesson || checking) return;
    setChecking(true);
    setNotice(null);
    try {
      const res = await api.check(lessonKey, filesRef.current);
      setCheckResults(res.checks);
      setPreviewChecks(null);
      if (res.run && lesson.language !== "html-css") setResult(res.run);
      if (res.completed && !completed) {
        setCompleted(true);
        onProgressChange();
      }
    } catch (err) {
      // ApiError carries the server's friendly text (e.g. the winget command
      // when a runtime is missing → 409).
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }

  function handleRestore(restored: Record<string, string>) {
    setFiles(restored);
    if (lesson?.language === "html-css") setPreview(buildSrcdoc(restored));
    scheduleSave();
    setActiveFile((f) => f || (lesson?.files[0]?.path ?? ""));
    setEditorGen((g) => g + 1); // remount the editor with the restored doc
  }

  const handleTutorEvent = useCallback(
    (e: TutorEvent) => {
      if (e.type === "check-results") {
        setCheckResults(e.checks);
        setPreviewChecks(null);
        if (e.completed) {
          setCompleted(true);
          onProgressChange();
        }
      } else if (e.type === "complete") {
        setCompleted(true);
        onProgressChange();
      } else if (e.type === "hint") {
        setRevealedHints((prev) => (prev.includes(e.index) ? prev : [...prev, e.index].sort()));
      } else if (e.type === "doc") {
        onOpenDoc(e.slug);
      }
    },
    [onProgressChange, onOpenDoc],
  );

  function revealNextHint() {
    if (!lesson?.hints) return;
    const next = lesson.hints.findIndex((_, i) => !revealedHints.includes(i));
    if (next >= 0) setRevealedHints((prev) => [...prev, next].sort());
  }

  // ---------- pane resize (drag the dividers; sizes persist in settings) ----------

  function paneDragMove(divider: 0 | 1, e: React.PointerEvent<HTMLDivElement>) {
    if (!paneDragging.current || !layoutRef.current) return;
    const rect = layoutRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setPaneSizes(([lessonPct, , tutorPct]) => {
      let l = lessonPct;
      let t = tutorPct;
      if (divider === 0) l = Math.min(Math.max(pct, 15), 100 - t - 20);
      else t = Math.min(Math.max(100 - pct, 12), 100 - l - 20);
      return [l, 100 - l - t, t];
    });
  }

  function paneDragEnd() {
    if (!paneDragging.current) return;
    paneDragging.current = false;
    const sizes = paneSizesRef.current.map((n) => Math.round(n * 10) / 10);
    cachedPaneSizes = sizes;
    api
      .settings()
      .then((s) => api.saveSettings({ ...s, layout: { ...(s.layout ?? {}), paneSizes: sizes } }))
      .catch(() => {});
  }

  const paneDivider = (divider: 0 | 1, label: string) => (
    <div
      className="pane-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={(e) => {
        e.preventDefault();
        paneDragging.current = true;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // capture is an optimization — the drag still works without it
        }
      }}
      onPointerMove={(e) => paneDragMove(divider, e)}
      onPointerUp={paneDragEnd}
      onPointerCancel={paneDragEnd}
    />
  );

  if (error) return <div className="view-pad">Failed to load lesson: {error}</div>;
  if (!lesson) return <div className="view-pad">Loading…</div>;

  const hintsAvailable = (lesson.hints?.length ?? 0) > 0 && level >= 2;
  const hintsLeft = (lesson.hints?.length ?? 0) - revealedHints.length;

  return (
    <div
      className="lesson-layout"
      ref={layoutRef}
      style={
        {
          "--pane-lesson": `${paneSizes[0]}%`,
          "--pane-work": `${paneSizes[1]}%`,
          "--pane-tutor": `${paneSizes[2]}%`,
        } as React.CSSProperties
      }
    >
      <section className="pane pane-lesson" aria-label="Lesson">
        <button className="back-link" onClick={() => navigate({ view: "track", trackId: lesson.trackId })}>
          ← Back to {lesson.trackId}
        </button>
        {project && (
          <nav className="stage-rail" aria-label={`${project.title} stages`}>
            <div className="stage-rail-title">{project.title}</div>
            <ol role="list">
              {project.stages.map((s, i) => (
                <li key={s.key}>
                  <button
                    className={`stage-row ${s.key === lessonKey ? "current" : ""}`}
                    aria-current={s.key === lessonKey ? "step" : undefined}
                    onClick={() => navigate({ view: "lesson", key: s.key })}
                  >
                    <span className={`check ${s.completedAt ? "done" : ""}`}>{s.completedAt ? "✓" : i + 1}</span>
                    <span className="stage-title">{s.title}</span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        )}
        <h2>
          {lesson.title} {completed && <span className="check done">✓</span>}
        </h2>
        <div className="goal-box">
          <div className="label">Goal</div>
          {lesson.goal}
        </div>
        {(lesson.docs?.length ?? 0) > 0 && (
          <div className="doc-chips">
            {lesson.docs!.map((slug) => (
              <button key={slug} className="doc-chip" onClick={() => onOpenDoc(slug)}>
                📖 {slug.split("/").pop()?.replaceAll("-", " ")}
              </button>
            ))}
          </div>
        )}
        <GoalChecklist
          checks={lesson.checks}
          results={checkResults}
          previews={previewChecks}
          checking={checking}
          onCheck={handleCheck}
        />
        {project && !completed && (
          <button className="unstick-btn" onClick={handleUseReference}>
            I'm stuck — use the reference for this stage
          </button>
        )}
        {completed &&
          (lesson.nextLessonKey ? (
            <button
              className="primary next-lesson-btn"
              onClick={() => navigate({ view: "lesson", key: lesson.nextLessonKey! })}
            >
              {project ? "Next stage →" : "Next lesson →"}
            </button>
          ) : project ? (
            <button className="next-lesson-btn" onClick={() => navigate({ view: "track", trackId: lesson.trackId })}>
              🎉 You built {project.title} — back to the track
            </button>
          ) : (
            <button className="next-lesson-btn" onClick={() => navigate({ view: "track", trackId: lesson.trackId })}>
              🎉 You've finished every lesson here so far — back to the track
            </button>
          ))}
        {revealedHints.length > 0 && (
          <div className="hints-box">
            <div className="label">Hints</div>
            <ol>
              {revealedHints.map((i) => (
                <li key={i}>{lesson.hints?.[i]}</li>
              ))}
            </ol>
          </div>
        )}
        {hintsAvailable && hintsLeft > 0 && (
          <button className="hint-btn" onClick={revealNextHint}>
            💡 Show a hint ({hintsLeft} left)
          </button>
        )}
        <div className="lesson-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(lesson.body) }} />
      </section>

      {paneDivider(0, "Resize lesson pane")}

      <section className="pane pane-work" aria-label="Code workspace">
        {lesson.files.length > 1 && (
          <div className="file-tabs" role="tablist" aria-label="Lesson files">
            {lesson.files.map((f, i) => (
              <button
                key={f.path}
                role="tab"
                aria-selected={activeFile === f.path}
                tabIndex={activeFile === f.path ? 0 : -1}
                className={`file-tab ${activeFile === f.path ? "active" : ""}`}
                onClick={() => setActiveFile(f.path)}
                onKeyDown={(e) => tabListKeyDown(e, i, lesson.files.length, (n) => setActiveFile(lesson.files[n].path))}
              >
                {f.path}
              </button>
            ))}
          </div>
        )}
        {activeFile && (
          <EditorPane
            key={`${lessonKey}:${activeFile}:${editorGen}`}
            code={files[activeFile] ?? ""}
            filename={activeFile}
            language={lesson.language}
            dark={theme === "dark"}
            running={running}
            onChange={handleChange}
            onRun={handleRun}
            toolbarExtra={
              <>
                <HistoryMenu lessonKey={lessonKey} onRestore={handleRestore} />
                <button onClick={() => handleRestore(lesson.starterFiles)}>Reset</button>
              </>
            }
          />
        )}
        <OutputPane
          result={result}
          preview={lesson.language === "html-css" ? preview : null}
          notice={notice}
          language={lesson.language}
          tutorAvailable={tutorAvailable}
          onExplainError={() =>
            setPendingTutorMsg("Please explain this error to me in plain language — what it means and where to look. Don't solve the rest of the lesson for me.")
          }
        />
      </section>

      {paneDivider(1, "Resize tutor pane")}

      <section className="pane pane-tutor" aria-label="Tutor">
        <TutorChat
          lessonKey={lessonKey}
          level={level}
          onLevelChange={handleLevelChange}
          getContext={() => ({ files: filesRef.current, lastRun: resultRef.current })}
          onEvent={handleTutorEvent}
          pendingMessage={pendingTutorMsg}
          onPendingConsumed={() => setPendingTutorMsg(null)}
          tutorAvailable={tutorAvailable}
          tutorState={tutorState}
        />
      </section>
    </div>
  );
}
