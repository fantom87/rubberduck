import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistanceLevel, Settings as SettingsType } from "@teacher/shared";
import { ASSISTANCE_NAMES } from "@teacher/shared";
import { api, tutorAvailability, type Health } from "../api/client";

/** One line saying whether the tutor works and, when it doesn't, which of the
 *  two fixes applies — installing Claude Code, or signing the one you have in. */
function tutorLine(health: Health): { ok: boolean; text: string } {
  const { state } = tutorAvailability(health);
  const detail = health.tutor?.detail ?? health.sdkAuthDetail ?? "";
  if (state === "ok") {
    const where = health.tutor?.executable;
    return { ok: true, text: `Tutor connection: ✓ using your own Claude Code${where ? ` at ${where}` : ""}` };
  }
  if (state === "not-installed") {
    return {
      ok: false,
      text: "Tutor connection: ✗ no Claude Code found — install it from claude.com/product/claude-code, or set its path above.",
    };
  }
  if (state === "not-logged-in") {
    return { ok: false, text: `Tutor connection: ✗ Claude Code isn't signed in — run "claude setup-token" in a terminal. ${detail}` };
  }
  return { ok: true, text: "Tutor connection: checking…" };
}

export default function Settings({ onSettingsChange }: { onSettingsChange: (s: SettingsType) => void }) {
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [profile, setProfile] = useState("");
  const [profileDirty, setProfileDirty] = useState(false);
  const [error, setError] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const load = useCallback(() => {
    setError(false);
    api.settings().then(setSettings).catch(() => setError(true));
    api.health().then(setHealth).catch(() => {});
    api.profile().then((j) => setProfile(j.profile)).catch(() => {});
  }, []);

  useEffect(load, [load]);

  function showToast(message: string) {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  }

  // Optimistic save with rollback: the server zod-validates and 400s bad
  // payloads (e.g. a cleared number field) — the UI must not silently keep
  // showing a value that never landed on disk.
  async function save(next: SettingsType) {
    const prev = settings;
    setSettings(next);
    onSettingsChange(next);
    try {
      await api.saveSettings(next);
    } catch (err) {
      if (prev) {
        setSettings(prev);
        onSettingsChange(prev);
      }
      showToast(`Couldn't save settings: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function saveProfile() {
    try {
      await api.saveProfile(profile);
      setProfileDirty(false);
    } catch (err) {
      showToast(`Couldn't save notes: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function resetProgress() {
    if (!confirm("Really reset ALL progress, streaks, and the journal? This can't be undone.")) return;
    try {
      await api.resetProgress();
      location.reload();
    } catch (err) {
      showToast(`Reset failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (error && !settings) {
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
  if (!settings) return <div className="view-pad">Loading…</div>;

  return (
    <div className="view-pad settings-view">
      <h1>Settings</h1>

      <section>
        <h2>Appearance</h2>
        <label className="setting-row">
          Theme
          <select value={settings.theme} onChange={(e) => save({ ...settings, theme: e.target.value as "dark" | "light" })}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <label className="setting-row">
          Editor font size
          <input
            type="number"
            min={10}
            max={24}
            value={settings.editor.fontSize}
            onChange={(e) => save({ ...settings, editor: { ...settings.editor, fontSize: Number(e.target.value) } })}
          />
        </label>
        <label className="setting-row">
          Editor autocomplete
          <input
            type="checkbox"
            checked={settings.editor.autocomplete}
            onChange={(e) => save({ ...settings, editor: { ...settings.editor, autocomplete: e.target.checked } })}
          />
        </label>
      </section>

      <section>
        <h2>Practice</h2>
        <label className="setting-row">
          Weekly goal
          <select value={settings.weeklyGoal} onChange={(e) => save({ ...settings, weeklyGoal: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>
                {n} day{n === 1 ? "" : "s"} a week
              </option>
            ))}
          </select>
        </label>
        <p className="dim small">
          A day counts when you finish a lesson or spend 10 minutes on one. Each week you hit the goal keeps your streak
          going, and a missed day on its own never resets it. Small is fine: a goal you hit beats a goal you dread.
        </p>
      </section>

      <section>
        <h2>Tutor</h2>
        <label className="setting-row">
          Default assistance level
          <select
            value={settings.assistanceDefault}
            onChange={(e) => save({ ...settings, assistanceDefault: Number(e.target.value) as AssistanceLevel })}
          >
            {([1, 2, 3, 4, 5] as AssistanceLevel[]).map((l) => (
              <option key={l} value={l}>
                {l} — {ASSISTANCE_NAMES[l]}
              </option>
            ))}
          </select>
        </label>
        <label className="setting-row">
          Tutor model
          <select
            value={settings.tutorModel}
            onChange={(e) => save({ ...settings, tutorModel: e.target.value as SettingsType["tutorModel"] })}
          >
            <option value="claude-sonnet-5">Sonnet 5 (fast, recommended)</option>
            <option value="claude-opus-4-8">Opus 4.8 (deeper)</option>
            <option value="claude-fable-5">Fable 5 (deepest)</option>
          </select>
        </label>
        <label className="setting-row">
          Claude Code path
          <input
            type="text"
            className="mono"
            placeholder="(found automatically)"
            defaultValue={settings.claudePath ?? ""}
            aria-describedby="claude-path-help"
            onBlur={(e) => {
              const next = e.target.value.trim();
              if (next === (settings.claudePath ?? "")) return;
              const { claudePath: _drop, ...rest } = settings;
              void save(next ? { ...rest, claudePath: next } : rest);
            }}
          />
        </label>
        <p id="claude-path-help" className="dim small">
          Only needed if your Claude Code lives somewhere unusual — otherwise leave it blank. Takes effect on the next
          message to the tutor.
        </p>
        {health && <p className={`small ${tutorLine(health).ok ? "dim" : "auth-warn"}`}>{tutorLine(health).text}</p>}
      </section>

      <section>
        <h2>What the tutor knows about you</h2>
        <p className="dim small">
          The tutor keeps short notes to teach you better. You can edit or delete anything here — it's your file.
        </p>
        <textarea
          className="profile-editor mono"
          rows={6}
          value={profile}
          aria-label="Learner profile notes"
          onChange={(e) => {
            setProfile(e.target.value);
            setProfileDirty(true);
          }}
        />
        {profileDirty && (
          <button className="primary" onClick={saveProfile}>
            Save notes
          </button>
        )}
      </section>

      <section>
        <h2>Local runtimes</h2>
        {health && (
          <ul className="runtime-list">
            <li>Python: {health.runtimes.python ?? "not found — winget install Python.Python.3.12"}</li>
            <li>Node: {health.runtimes.node ?? "not found — winget install OpenJS.NodeJS.LTS"}</li>
            <li>.NET (for C#): {health.runtimes.dotnet ?? "not found — winget install Microsoft.DotNet.SDK.8"}</li>
            <li>Go: {health.runtimes.go ?? "not found — download from https://go.dev/dl"}</li>
            <li>Rust: {health.runtimes.rust ?? "not found — install from https://rustup.rs"}</li>
            <li>PowerShell: {health.runtimes.powershell ?? "not found"}</li>
            <li>Bash (Git): {health.runtimes.bash ?? "not found — comes with Git for Windows"}</li>
            <li>SQL: {health.runtimes.sql}</li>
          </ul>
        )}
      </section>

      <section>
        <h2>Your data</h2>
        <p className="dim small">
          Everything the app stores about you — settings, progress, journal, and drafts — as one JSON file.
        </p>
        <a className="download-link" href="/api/export" download>
          ⬇ Download my data
        </a>
      </section>

      <section>
        <h2>Danger zone</h2>
        <button className="danger" onClick={resetProgress}>
          Reset all progress
        </button>
      </section>

      {toast && (
        <div className="toast" role="alert">
          {toast}
        </div>
      )}
    </div>
  );
}
