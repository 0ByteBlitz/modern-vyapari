import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

/**
 * A Refresh control that says what happened.
 *
 * Refresh buttons used to call a loader and show nothing: when the data hadn't
 * changed — the normal case — a click was indistinguishable from a click that
 * did nothing at all. This one spins for at least `MIN_SPIN_MS` (local reads
 * finish in a few milliseconds, too fast to see), then states the result:
 * "updated 12:04:31", or that it failed.
 *
 * `onRefresh` resolves `false` (or throws) to report a failure; anything else
 * counts as success.
 */
const MIN_SPIN_MS = 450;

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function RefreshButton({
  onRefresh,
  label = "Refresh",
  title,
  iconOnly = false,
  className = "btn",
  size = 13,
}: {
  onRefresh: () => Promise<unknown>;
  label?: string;
  title?: string;
  /** Icon-only buttons put the result in the tooltip and a short note beside. */
  iconOnly?: boolean;
  className?: string;
  size?: number;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; at: number } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  async function run() {
    if (busy) return;
    setBusy(true);
    const started = Date.now();
    let ok = true;
    try {
      ok = (await onRefresh()) !== false;
    } catch {
      ok = false;
    }
    const wait = MIN_SPIN_MS - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (!alive.current) return;
    setBusy(false);
    setResult({ ok, at: Date.now() });
  }

  const status = result ? (result.ok ? `updated ${clock(result.at)}` : "couldn't refresh") : null;

  return (
    <span className="refresh-control">
      <button
        className={className}
        onClick={() => void run()}
        disabled={busy}
        aria-busy={busy}
        title={[title ?? label, status].filter(Boolean).join(" — ")}
      >
        <RefreshCw size={size} className={busy ? "animate-spin" : ""} />
        {!iconOnly && <span>{busy ? "Refreshing…" : label}</span>}
      </button>
      {status && (
        <span className={`refresh-status ${result!.ok ? "" : "refresh-status-failed"}`} role="status">
          {status}
        </span>
      )}
    </span>
  );
}
