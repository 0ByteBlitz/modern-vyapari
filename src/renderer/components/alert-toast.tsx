import { useEffect, useState } from "react";
import { Bell, X, CheckCheck } from "lucide-react";
import { api } from "@/lib/api";
import type { AlertEvent } from "@/lib/api";
import { formatPrice } from "@/lib/format";
import { playAlertSoundLoop, stopAlertSound } from "@/lib/alert-sound";
import { describeThreshold } from "@shared/levels";

/**
 * Live toast feed for triggered alerts (plan §9b: "Local alert engine").
 * Subscribes once at the app root so a trigger surfaces no matter which
 * page is currently active — the whole point of an alert is you don't
 * have to be staring at the Bot page when it fires.
 */

interface Toast extends AlertEvent {
  toastId: string;
}

const AUTO_DISMISS_MS = 15_000;

export function AlertToastHost({ onOpenBot }: { onOpenBot?: () => void }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const unsubscribe = api.onAlertTriggered((event) => {
      const toast: Toast = { ...event, toastId: `${event.alertId}-${event.triggeredAt}` };
      setToasts((prev) => [toast, ...prev].slice(0, 5));
      playAlertSoundLoop();

      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.toastId !== toast.toastId));
      }, AUTO_DISMISS_MS);
    });
    return () => {
      unsubscribe();
      stopAlertSound();
    };
  }, []);

  // Control sound playback based on remaining active toasts
  useEffect(() => {
    if (toasts.length === 0) {
      stopAlertSound();
    }
  }, [toasts.length]);

  if (toasts.length === 0) return null;

  const dismiss = (toastId: string) => setToasts((prev) => prev.filter((t) => t.toastId !== toastId));
  const dismissAll = () => {
    setToasts([]);
    stopAlertSound();
  };

  return (
    <div className="alert-toast-host">
      {toasts.length > 1 && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
          <button
            onClick={dismissAll}
            style={{
              background: "var(--surface-3)",
              border: "1px solid var(--border)",
              color: "var(--text-secondary)",
              borderRadius: "var(--radius-sm)",
              padding: "4px 10px",
              fontSize: "var(--text-xs)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <CheckCheck size={12} style={{ color: "var(--accent)" }} />
            <span>Dismiss All ({toasts.length})</span>
          </button>
        </div>
      )}
      {toasts.map((t) => (
        <div
          key={t.toastId}
          className="alert-toast"
          onClick={() => {
            onOpenBot?.();
            dismiss(t.toastId);
          }}
        >
          <Bell className="w-4 h-4 shrink-0 text-amber-400" />
          <div className="alert-toast-body">
            <span className="alert-toast-label">{t.label}</span>
            <span className="alert-toast-meta">
              {t.symbol} · {t.condition?.indicator} {(t.condition?.operator || "").replace(/_/g, " ")}{" "}
              {describeThreshold(t.condition?.value)}
              {t.currentValue !== null && t.currentValue !== undefined ? ` (now ${formatPrice(t.currentValue)})` : ""}
            </span>
          </div>
          <button
            className="alert-toast-close"
            onClick={(e) => {
              e.stopPropagation();
              dismiss(t.toastId);
            }}
            title="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
