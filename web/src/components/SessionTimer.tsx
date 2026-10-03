import { useEffect, useRef, useState } from "react";

interface Props {
  endsAt: number;
  onDone: () => void;
  onCancel: () => void;
}

/**
 * The quiet countdown in the top bar. role="timer" keeps screen readers from
 * announcing every second; it takes keyboard focus, and its label carries the
 * full reading when it has it. Only this component re-renders each second.
 */
export default function SessionTimer({ endsAt, onDone, onCancel }: Props) {
  const [now, setNow] = useState(() => Date.now());
  const fired = useRef(false);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const left = Math.max(0, endsAt - now);
  useEffect(() => {
    if (left === 0 && !fired.current) {
      fired.current = true;
      onDone();
    }
  }, [left, onDone]);

  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);
  return (
    <span
      className="session-chip"
      role="timer"
      tabIndex={0}
      aria-label={`${minutes} minutes ${seconds} seconds left in this session`}
    >
      ⏱ {minutes}:{String(seconds).padStart(2, "0")}
      <button className="session-cancel" aria-label="End the session now" title="End the session now" onClick={onCancel}>
        ✕
      </button>
    </span>
  );
}
