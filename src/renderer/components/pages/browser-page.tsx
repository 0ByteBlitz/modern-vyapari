import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Home, RotateCw, ShieldCheck } from "lucide-react";
import { api, isError, type BrowserState } from "@/lib/api";

/**
 * Embedded browser (Phase 1 surface 3). The actual page content is a native
 * Electron WebContentsView stacked on top of the `.browser-viewport`
 * placeholder below — positioned via getBoundingClientRect() on every
 * resize, shown on mount, hidden on unmount. Display-only research surface:
 * the bot never reads or automates it (TradingView ToS §3, docs/PLAN.md §9);
 * pasting a snapshot into chat is the only bridge to the AI. Isolated
 * session + tracker blocklist live in src/main/browser/embedded-browser.ts.
 */
export function BrowserPage() {
  const placeholderRef = useRef<HTMLDivElement>(null);
  const isEditingRef = useRef(false);
  const [addressInput, setAddressInput] = useState("");
  const [state, setState] = useState<BrowserState | null>(null);

  const syncBounds = useCallback(() => {
    const el = placeholderRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    void api.browserSetBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }, []);

  const handleNavigate = useCallback(() => {
    if (!addressInput.trim()) return;
    void api.browserNavigate(addressInput.trim());
  }, [addressInput]);

  useEffect(() => {
    void api.browserShow();
    syncBounds();

    void api.browserGetState().then((res) => {
      if (!isError(res) && res) {
        setState(res);
        setAddressInput(res.url);
      }
    });

    const unsub = api.onBrowserState((s) => {
      setState(s);
      setAddressInput((prev) => (isEditingRef.current ? prev : s.url));
    });

    const ro = new ResizeObserver(() => syncBounds());
    if (placeholderRef.current) ro.observe(placeholderRef.current);
    window.addEventListener("resize", syncBounds);

    return () => {
      unsub();
      ro.disconnect();
      window.removeEventListener("resize", syncBounds);
      void api.browserHide();
    };
  }, [syncBounds]);

  return (
    <div className="browser-page">
      <header className="browser-page-head">
        <div>
          <h1 className="surface-title">Research browser</h1>
          <p className="surface-sub">Use web sources for research. Page content never triggers a plan.</p>
        </div>
        <span className="browser-isolated-label"><ShieldCheck size={14} /> Isolated</span>
      </header>
      <div className="browser-toolbar">
        <div className="browser-nav-buttons">
          <button
            className="btn btn-ghost browser-nav-btn"
            onClick={() => void api.browserGoBack()}
            disabled={!state?.canGoBack}
            title="Back"
            aria-label="Back"
          >
            <ArrowLeft size={15} />
          </button>
          <button
            className="btn btn-ghost browser-nav-btn"
            onClick={() => void api.browserGoForward()}
            disabled={!state?.canGoForward}
            title="Forward"
            aria-label="Forward"
          >
            <ArrowRight size={15} />
          </button>
          <button
            className="btn btn-ghost browser-nav-btn"
            onClick={() => void api.browserReload()}
            title="Reload"
            aria-label="Reload page"
          >
            <RotateCw size={15} className={state?.loading ? "animate-spin" : ""} />
          </button>
          <button className="btn btn-ghost browser-nav-btn" onClick={() => void api.browserGoHome()} title="Home" aria-label="Home">
            <Home size={15} />
          </button>
        </div>

        <div className="browser-address-bar">
          <ShieldCheck size={14} className="browser-address-shield" aria-label="Isolated session; permissions denied and trackers blocked" />
          <input
            value={addressInput}
            onChange={(e) => setAddressInput(e.target.value)}
            onFocus={() => {
              isEditingRef.current = true;
            }}
            onBlur={() => {
              isEditingRef.current = false;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
                handleNavigate();
              }
            }}
            placeholder="Enter a URL…"
            className="browser-address-input"
            aria-label="Research browser address"
          />
        </div>

        {state?.title && <span className="browser-page-title">{state.title}</span>}
      </div>

      <div ref={placeholderRef} className="browser-viewport" />
    </div>
  );
}
