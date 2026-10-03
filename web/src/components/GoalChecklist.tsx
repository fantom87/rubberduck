import { useEffect, useRef, useState } from "react";
import type { CheckResult, CheckSpec } from "@teacher/shared";

interface Props {
  checks: CheckSpec[];
  /** Server-confirmed results (Check my work / tutor check_goal). */
  results: CheckResult[] | null;
  /** Browser-side instant verdicts after a Run — shown dimmed as "preview"
   *  until the server check confirms them. */
  previews?: CheckResult[] | null;
  checking: boolean;
  onCheck: () => void;
  /** One row, for the focus-mode bar above the editor. */
  compact?: boolean;
}

type CheckState = "todo" | "pass" | "fail" | "unreachable";

function describe(spec: CheckSpec): string {
  switch (spec.type) {
    case "stdout":
      return "Program output matches the goal";
    case "tests":
      return "All tests pass";
    case "dom":
      return "Page structure is right";
    case "ai-judge":
      return "Tutor approves the approach";
  }
}

// How long a just-passed check keeps its highlight.
const POP_MS = 900;

export default function GoalChecklist({ checks, results, previews, checking, onCheck, compact }: Props) {
  const rows = checks.map((spec) => {
    const preview = previews?.find((r) => r.checkId === spec.id);
    const confirmed = results?.find((r) => r.checkId === spec.id);
    const result = preview ?? confirmed;
    const state: CheckState =
      result === undefined ? "todo" : result.unreachable ? "unreachable" : result.passed ? "pass" : "fail";
    return { spec, result, state, isPreview: preview !== undefined };
  });

  // A small win the moment each check goes green, not only when the whole
  // lesson completes. Tracks the last state per check and pops the ones that
  // just turned to pass.
  const previous = useRef<Map<string, CheckState> | null>(null);
  const popTimer = useRef<number | undefined>(undefined);
  const [popped, setPopped] = useState<Set<string>>(new Set());
  const signature = rows.map((r) => `${r.spec.id}:${r.state}`).join("|");
  useEffect(() => {
    const before = previous.current;
    previous.current = new Map(rows.map((r) => [r.spec.id, r.state]));
    // The first look is a baseline, not news: a checklist that mounts with
    // checks already passing (focus mode toggled on, say) has nothing to pop.
    if (before === null) return;
    const fresh = rows.filter((r) => r.state === "pass" && before.get(r.spec.id) !== "pass").map((r) => r.spec.id);
    if (fresh.length === 0) return;
    // The timer lives in a ref, not an effect cleanup: a cleanup would cancel
    // it whenever the states change again inside POP_MS, and the highlight
    // would never clear.
    window.clearTimeout(popTimer.current);
    setPopped(new Set(fresh));
    popTimer.current = window.setTimeout(() => setPopped(new Set()), POP_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  useEffect(() => () => window.clearTimeout(popTimer.current), []);

  const graded = rows.filter((r) => r.state !== "todo");
  const passing = rows.filter((r) => r.state === "pass").length;

  return (
    <div className={`goal-checklist${compact ? " compact" : ""}`}>
      <ul aria-live="polite">
        {rows.map(({ spec, result, state, isPreview }) => (
          <li
            key={spec.id}
            className={`goal-item ${state}${isPreview ? " preview" : ""}${popped.has(spec.id) ? " just-passed" : ""}`}
          >
            <span className="check-icon">
              {state === "pass" ? "✓" : state === "fail" ? "✗" : state === "unreachable" ? "◌" : "○"}
            </span>
            <span>
              {describe(spec)}
              {isPreview && <span className="preview-tag">preview</span>}
              {!compact && state === "unreachable" && result && (
                <div className="check-message unreachable-message">{result.message}</div>
              )}
              {!compact && state === "fail" && result && <div className="check-message">{result.message}</div>}
              {compact && state === "fail" && result && (
                <span className="check-message-inline"> — {result.message.split("\n")[0]}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {graded.length > 0 && rows.length > 1 && (
        <div className="checks-tally dim small">
          {passing} of {rows.length} passing
        </div>
      )}
      <button className="primary" onClick={onCheck} disabled={checking}>
        {checking ? "Checking…" : "Check my work"}
      </button>
    </div>
  );
}
