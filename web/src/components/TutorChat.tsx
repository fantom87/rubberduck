import { memo, useEffect, useRef, useState } from "react";
import type { AssistanceLevel, RunResult } from "@teacher/shared";
import AssistanceSlider from "./AssistanceSlider";
import { openTutorStream, type TutorEvent } from "../api/tutorStream";
import type { TutorState } from "../api/client";
import { renderMarkdown } from "../md";
import { SAMPLE_TRANSCRIPT } from "../data/sampleTranscript";

export const CLAUDE_CODE_URL = "https://claude.com/product/claude-code";

export interface ChatItem {
  role: "user" | "assistant" | "chip";
  text: string;
  /** chip flavor: errors are red, usage-limit pauses are amber */
  variant?: "error" | "limit";
}

interface Props {
  lessonKey: string;
  level: AssistanceLevel;
  onLevelChange?: (level: AssistanceLevel) => void;
  /** Placement mode has no level policies — hide the slider there. */
  hideSlider?: boolean;
  getContext: () => { files: Record<string, string>; lastRun: RunResult | null };
  onEvent: (e: TutorEvent) => void;
  /** Set from outside to send a canned message (e.g. "explain this error"). */
  pendingMessage?: string | null;
  onPendingConsumed?: () => void;
  /** false when /api/health reports the tutor can't be reached. */
  tutorAvailable?: boolean;
  /** which kind of unreachable — the two have different fixes. */
  tutorState?: TutorState;
}

/**
 * Memoised on its text: a streamed token used to push every message in the
 * transcript back through marked + DOMPurify. Now only the message that grew
 * re-renders, and the rest are skipped by reference.
 */
const AssistantMessage = memo(function AssistantMessage({ text }: { text: string }) {
  return <div dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
});

const CHIP_LABEL: Record<string, string> = {
  run_code: "Ran your code",
  check_goal: "Checked your goals",
  mark_complete: "Marked complete",
  show_hint: "Revealed a hint",
  show_doc: "Opened a doc page",
  update_profile: "Made a note",
};

// If the stream stays silent this long after a send, assume the turn was lost
// (server restart, dropped session) and unlock the input with a retry chip.
const WATCHDOG_MS = 30_000;

// Don't yank the scroll position while streaming if the reader has scrolled
// up more than this from the bottom.
const STICK_TO_BOTTOM_PX = 80;

export default function TutorChat({
  lessonKey,
  level,
  onLevelChange,
  hideSlider,
  getContext,
  onEvent,
  pendingMessage,
  onPendingConsumed,
  tutorAvailable,
  tutorState,
}: Props) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [canRetry, setCanRetry] = useState(false);
  const busyRef = useRef(false);
  const streamingRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const lastSentRef = useRef<string | null>(null);
  const watchdogRef = useRef<number | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  function clearWatchdog() {
    if (watchdogRef.current !== undefined) {
      window.clearTimeout(watchdogRef.current);
      watchdogRef.current = undefined;
    }
  }

  function setBusyState(b: boolean) {
    busyRef.current = b;
    setBusy(b);
    if (!b) clearWatchdog();
  }

  function armWatchdog() {
    clearWatchdog();
    watchdogRef.current = window.setTimeout(() => {
      watchdogRef.current = undefined;
      if (!busyRef.current) return;
      busyRef.current = false;
      setBusy(false);
      streamingRef.current = false;
      setCanRetry(true);
      setItems((prev) => [
        ...prev,
        { role: "chip", text: "⚠ The tutor hasn't responded — it may be offline or busy.", variant: "error" },
      ]);
    }, WATCHDOG_MS);
  }

  useEffect(() => {
    // A fresh key (or remount) starts from a clean slate; the server replays
    // its buffered transcript for this key over the stream, rebuilding the
    // visible conversation. Never carry busy over from the previous key —
    // its turn-end belongs to the old subscription.
    setItems([]);
    setBusyState(false);
    streamingRef.current = false;
    setCanRetry(false);
    stickToBottomRef.current = true;
    const close = openTutorStream(lessonKey, (e) => {
      // Any activity proves the turn is alive — push the watchdog out.
      if (busyRef.current) armWatchdog();
      onEvent(e);
      if (e.type === "text-delta") {
        setItems((prev) => {
          const next = [...prev];
          if (!streamingRef.current || next.length === 0 || next[next.length - 1].role !== "assistant") {
            next.push({ role: "assistant", text: e.text });
            streamingRef.current = true;
          } else {
            next[next.length - 1] = { role: "assistant", text: next[next.length - 1].text + e.text };
          }
          return next;
        });
      } else if (e.type === "tool-use") {
        streamingRef.current = false;
        setItems((prev) => [...prev, { role: "chip", text: CHIP_LABEL[e.name] ?? e.name }]);
      } else if (e.type === "turn-end") {
        streamingRef.current = false;
        setBusyState(false);
      } else if (e.type === "error") {
        streamingRef.current = false;
        setBusyState(false);
        const limit = /usage limit/i.test(e.message);
        setItems((prev) => [
          ...prev,
          { role: "chip", text: `${limit ? "⏳" : "⚠"} ${e.message}`, variant: limit ? "limit" : "error" },
        ]);
      }
    });
    return () => {
      close();
      clearWatchdog();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonKey, onEvent]);

  useEffect(() => {
    if (stickToBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [items, busy]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX;
  }

  function failSend(message: string) {
    setBusyState(false);
    streamingRef.current = false;
    setCanRetry(true);
    setItems((prev) => [...prev, { role: "chip", text: `⚠ ${message}`, variant: "error" }]);
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busyRef.current) return;
    setCanRetry(false);
    lastSentRef.current = trimmed;
    setItems((prev) => [...prev, { role: "user", text: trimmed }]);
    setBusyState(true);
    armWatchdog();
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    const ctx = getContext();
    try {
      const res = await fetch("/api/tutor/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId: lessonKey, text: trimmed, files: ctx.files, lastRun: ctx.lastRun, level }),
      });
      if (!res.ok) {
        let message = `The tutor couldn't take that message (HTTP ${res.status}).`;
        try {
          const data = (await res.json()) as { error?: unknown };
          if (typeof data.error === "string" && data.error) message = data.error;
        } catch {
          // non-JSON body — keep the generic message
        }
        failSend(message);
      }
    } catch (err) {
      failSend(String(err));
    }
  }

  // Canned messages ("explain this error") queue behind a busy turn instead of
  // silently vanishing: the effect re-runs when busy clears and sends then.
  useEffect(() => {
    if (pendingMessage && !busy) {
      void send(pendingMessage);
      onPendingConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMessage, busy]);

  function handleLevel(l: AssistanceLevel) {
    onLevelChange?.(l);
    void fetch("/api/tutor/level", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lessonId: lessonKey, level: l }),
    });
  }

  async function handleStop() {
    try {
      const res = await fetch("/api/tutor/interrupt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId: lessonKey }),
      });
      if (res.ok) {
        setBusyState(false);
        streamingRef.current = false;
      }
    } catch {
      // the server's turn-end event clears busy if the request did land
    }
  }

  async function handleReset() {
    try {
      await fetch(`/api/tutor?id=${encodeURIComponent(lessonKey)}`, { method: "DELETE" });
    } catch {
      // server unreachable — still clear the local view
    }
    setItems([]);
    setBusyState(false);
    streamingRef.current = false;
    setCanRetry(false);
    lastSentRef.current = null;
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  function autosize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  // No tutor (no Claude Code installed, a fresh clone, a codespace, expired
  // auth): don't offer a chat that can only fail. Explain what the tutor does,
  // name the actual fix, and show a real recorded exchange, plainly labelled —
  // everything else in the app still works.
  if (tutorAvailable === false) {
    const notInstalled = tutorState === "not-installed";
    return (
      <div className="tutor-chat">
        <div className="tutor-header">
          <strong>{notInstalled ? "AI tutor — needs Claude Code" : "AI tutor — not signed in"}</strong>
        </div>
        <div className="chat-scroll tutor-offline">
          <p className="dim small">
            The tutor runs on your own copy of Claude Code — this app doesn't ship one. Everything else works without
            it: run your code, check your work, and complete lessons — an AI-graded check that can't be reached never
            blocks you.
          </p>
          {notInstalled ? (
            <p className="dim small">
              To switch it on, install{" "}
              <a href={CLAUDE_CODE_URL} target="_blank" rel="noreferrer">
                Claude Code
              </a>
              , run <code>claude setup-token</code> in a terminal, and restart the app. Already installed somewhere
              unusual? Point Settings at it.
            </p>
          ) : (
            <p className="dim small">
              Claude Code is installed but isn't signed in. Run <code>claude setup-token</code> in a terminal, then
              restart the app.
            </p>
          )}
          <div className="transcript-label">Recorded example — a real session, not live</div>
          {SAMPLE_TRANSCRIPT.map((block, bi) => (
            <div key={bi} className="transcript-block">
              <div className="transcript-level">assistance level {block.level}</div>
              {block.items.map((item, i) =>
                item.role === "chip" ? (
                  <div key={i} className="chat-chip">
                    {item.text}
                  </div>
                ) : (
                  <div key={i} className={`chat-msg ${item.role}`}>
                    {item.role === "assistant" ? (
                      <AssistantMessage text={item.text} />
                    ) : (
                      item.text
                    )}
                  </div>
                ),
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="tutor-chat">
      <div className="tutor-header">
        {!hideSlider && <AssistanceSlider level={level} onChange={handleLevel} />}
        <button
          type="button"
          className="chat-reset"
          title="Clear this conversation and start fresh"
          onClick={() => void handleReset()}
        >
          ↺ New chat
        </button>
      </div>
      <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll} aria-live="polite">
        {items.length === 0 && (
          <p className="dim small chat-empty">
            Ask the tutor anything about this lesson — or just say hello. Slide the assistance level to change how much help you get.
          </p>
        )}
        {items.map((item, i) =>
          item.role === "chip" ? (
            <div key={i} className={`chat-chip${item.variant ? ` ${item.variant}` : ""}`}>
              {item.text}
            </div>
          ) : (
            <div key={i} className={`chat-msg ${item.role}`}>
              {item.role === "assistant" ? (
                <AssistantMessage text={item.text} />
              ) : (
                item.text
              )}
            </div>
          ),
        )}
        {busy && <div className="chat-chip">thinking…</div>}
        {canRetry && !busy && lastSentRef.current && (
          <button type="button" className="chat-retry" onClick={() => void send(lastSentRef.current!)}>
            ↻ Send again
          </button>
        )}
      </div>
      <form
        className="chat-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <textarea
          ref={inputRef}
          className="chat-input"
          value={input}
          rows={1}
          placeholder="Ask the tutor…"
          aria-label="Message the tutor"
          onChange={(e) => {
            setInput(e.target.value);
            autosize(e.currentTarget);
          }}
          onKeyDown={handleInputKeyDown}
        />
        {busy ? (
          <button type="button" onClick={() => void handleStop()}>
            ⏹ Stop
          </button>
        ) : (
          <button className="primary" type="submit" disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
