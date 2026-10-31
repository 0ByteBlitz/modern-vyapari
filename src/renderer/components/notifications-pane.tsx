import { useCallback, useEffect, useState } from "react";
import { Bell, Check, AlertTriangle, Send } from "lucide-react";
import { api, isError, errorText, type NotifyStatus } from "@/lib/api";

/**
 * Telegram, and the health of the outbox behind it.
 *
 * Two things are on this page rather than one, deliberately.
 *
 * The **channel** is the obvious half: without a token nothing sends. But the
 * **outbox counters** are the half that matters when something goes wrong — a
 * message the app gave up on is, by definition, one the owner was never told
 * about any other way. Hiding that behind a log file would defeat the point of
 * having a channel at all.
 *
 * The bot token is write-only from here: it goes down to the encrypted store
 * and never comes back. The chat id does come back, because it is an address
 * rather than a secret, and a wrong one fails silently from the owner's side —
 * seeing what is stored is the only way to catch that.
 */
export function NotificationsPane() {
  const [status, setStatus] = useState<NotifyStatus | null>(null);
  const [token, setToken] = useState("");
  const [chat, setChat] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api.notifyStatus();
    if (isError(res)) {
      setProblem(errorText(res));
      return;
    }
    setStatus(res);
    setChat((c) => c || res.chatId || "");
  }, []);

  useEffect(() => {
    void load();
    /* Slow poll: the counters move when the engine acts, which is rare. */
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  async function save() {
    setBusy(true);
    setProblem(null);
    setNote(null);
    const res = await api.saveTelegram(token, chat);
    setBusy(false);
    if (isError(res)) {
      setProblem(errorText(res));
      return;
    }
    /* Cleared from component state the moment it is stored — there is no
       reason for the token to sit in renderer memory afterwards. */
    setToken("");
    setNote("Saved. Send a test to confirm it reaches you.");
    await load();
  }

  async function test() {
    setBusy(true);
    setProblem(null);
    setNote(null);
    const res = await api.testNotification();
    setBusy(false);
    if (isError(res)) {
      setProblem(errorText(res));
      return;
    }
    if (res.ok) setNote("Sent. Check your phone.");
    else setProblem(res.reason);
  }

  async function disconnect() {
    setBusy(true);
    await api.clearTelegram();
    setBusy(false);
    setToken("");
    setChat("");
    setNote(null);
    await load();
  }

  const configured = status?.configured ?? false;

  return (
    <div className="integ-pane">
      <section className="panel">
        <div className="panel-header">
          <Bell size={13} style={{ color: "var(--accent)" }} />
          <span className="label-micro">Telegram</span>
          <span className="ml-auto">
            <span className={`badge badge-${configured ? "supervised" : "draft"}`}>
              {configured ? "connected" : "not connected"}
            </span>
          </span>
        </div>

        <div className="integ-body">
          <p className="integ-sub" style={{ marginBottom: 10 }}>
            Where the app reaches you when it isn't open — a plan triggering, expiring, or its
            thesis being invalidated.
          </p>

          <label className="plans-field">
            <span>Bot token</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={configured ? "•••••••• stored — leave blank to keep it" : "From @BotFather"}
              autoComplete="off"
            />
          </label>

          <label className="plans-field">
            <span>Chat ID</span>
            <input
              value={chat}
              onChange={(e) => setChat(e.target.value)}
              placeholder="Message your bot once, then read it from getUpdates"
              inputMode="text"
            />
          </label>

          <div className="plans-actions" style={{ marginTop: 8 }}>
            <button className="plans-primary" disabled={busy} onClick={() => void save()}>
              Save
            </button>
            <button className="plans-ghost" disabled={busy || !configured} onClick={() => void test()}>
              <Send size={12} /> Send test
            </button>
            {configured && (
              <button className="plans-ghost" disabled={busy} onClick={() => void disconnect()}>
                Disconnect
              </button>
            )}
          </div>

          {note && <p className="integ-note"><Check size={12} style={{ color: "var(--up)" }} /> {note}</p>}
          {problem && <p className="integ-problem">{problem}</p>}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="label-micro">Message queue</span>
          <span className="ml-auto" style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
            written when the event happens, sent when it can be
          </span>
        </div>
        <div className="integ-body">
          <div className="detail-facts">
            <div>
              <span className="label-micro">Waiting</span>
              <span className="mono">{status?.stats.pending ?? "—"}</span>
            </div>
            <div>
              <span className="label-micro">Sent</span>
              <span className="mono">{status?.stats.delivered ?? "—"}</span>
            </div>
            <div>
              <span className="label-micro">Gave up</span>
              <span className={`mono ${status && status.stats.abandoned > 0 ? "v-caution" : ""}`}>
                {status?.stats.abandoned ?? "—"}
              </span>
            </div>
          </div>

          {!configured && (status?.stats.pending ?? 0) > 0 && (
            /* The queue is not lost while disconnected — saying so is the
               difference between "these are gone" and "these are waiting". */
            <p className="integ-note">
              {status?.stats.pending} message{status?.stats.pending === 1 ? "" : "s"} waiting. Connect
              Telegram and they'll be delivered.
            </p>
          )}

          {status && status.abandoned.length > 0 && (
            <>
              <p className="integ-note">
                <AlertTriangle size={12} style={{ color: "var(--caution)" }} />
                These were never delivered. You weren't told about them any other way.
              </p>
              {status.abandoned.map((a, i) => (
                <div key={i} className="detail-level">
                  <span className="detail-level-role">{a.kind.replace(/_/g, " ")}</span>
                  <span className="detail-level-value">{a.title}</span>
                  <span className="detail-level-source ml-auto">{a.attempts} attempts</span>
                </div>
              ))}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
