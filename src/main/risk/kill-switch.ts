import { createLogger } from "../logger";

const log = createLogger("kill-switch");
import { ListenerRegistry } from "../events/listener-registry";

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
    log.error(`KILL SWITCH TRIPPED: ${reason}`);
    this.notify();
  }

  public reset(): void {
    if (!this.active) return;
    this.active = false;
    this.reason = "";
    log.info("Kill switch RESET to normal operation.");
    this.notify();
  }

  public onChange(cb: (active: boolean, reason: string) => void): () => void {
    return this.listeners.add(cb);
  }

  private notify() {
    this.listeners.emit(this.active, this.reason);
  }
}

export const killSwitch = new KillSwitchManager();
