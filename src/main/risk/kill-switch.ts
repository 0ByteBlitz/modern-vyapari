import { createLogger } from "../logger";

const log = createLogger("kill-switch");
import { ListenerRegistry } from "../events/listener-registry";

const SETTINGS_KEY = "kill_switch";

class KillSwitchManager {
  private active = false;
  private reason = "";
  private listeners = new ListenerRegistry<[boolean, string]>("kill switch");

  public isTripped(): boolean {
    return this.active;
  }

  public getReason(): string {
    return this.reason;
  }

  public trip(reason = "Emergency manual kill switch triggered"): void {
    if (this.active) return;
    this.active = true;
    this.reason = reason;
    this.persist();
    log.error(`KILL SWITCH TRIPPED: ${reason}`);
    this.notify();
  }

  public reset(): void {
    if (!this.active) return;
    this.active = false;
    this.reason = "";
    this.persist();
    log.info("Kill switch RESET to normal operation.");
    this.notify();
  }

  /**
   * Re-read a trip that outlived the process. Called once at startup, before
   * the engine starts.
   *
   * The switch lived in memory only, so a crash or a restart — the moments an
   * emergency is most likely to include — silently re-enabled entries for
   * every armed plan in every session, and nothing on screen said it had.
   * Only the owner's reset ends a trip.
   */
  public restore(): void {
    try {
      const { getDb } = require("../db/database") as typeof import("../db/database");
      const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(SETTINGS_KEY) as
        | { value: string }
        | undefined;
      if (!row) return;
      const saved = JSON.parse(row.value) as { reason?: string };
      this.active = true;
      this.reason = saved.reason || "Tripped before the last restart";
      log.error(`KILL SWITCH still tripped from before the restart: ${this.reason}`);
      this.notify();
    } catch (err) {
      log.error("Could not read the saved kill switch state", err);
    }
  }

  /** Best effort: the in-memory flag is what blocks entries right now, so a
   *  failed write must never undo a trip. */
  private persist(): void {
    try {
      const { getDb } = require("../db/database") as typeof import("../db/database");
      const db = getDb();
      if (this.active) {
        db.prepare(
          `INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        ).run(SETTINGS_KEY, JSON.stringify({ reason: this.reason, at: Date.now() }));
      } else {
        db.prepare(`DELETE FROM settings WHERE key = ?`).run(SETTINGS_KEY);
      }
    } catch (err) {
      log.error("Could not save the kill switch state", err);
    }
  }

  public onChange(cb: (active: boolean, reason: string) => void): () => void {
    return this.listeners.add(cb);
  }

  private notify() {
    this.listeners.emit(this.active, this.reason);
  }
}

export const killSwitch = new KillSwitchManager();
