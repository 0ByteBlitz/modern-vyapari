import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Home, RotateCw, ShieldCheck } from "lucide-react";
import { api, isError, type BrowserState } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
      <div className="browser-toolbar">
        <div className="browser-nav-buttons">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => void api.browserGoBack()}
            disabled={!state?.canGoBack}
            title="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => void api.browserGoForward()}
            disabled={!state?.canGoForward}
            title="Forward"
          >
            <ArrowRight className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => void api.browserReload()}
            title="Reload"
          >
            <RotateCw className={`h-4 w-4 ${state?.loading ? "animate-spin" : ""}`} />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => void api.browserGoHome()} title="TradingView">
            <Home className="h-4 w-4" />
          </Button>
        </div>

        <div className="browser-address-bar" title="Isolated session, permissions denied, trackers blocked">
          <ShieldCheck className="h-3.5 w-3.5 text-success shrink-0" />
          <Input
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
            className="h-8 text-xs bg-transparent border-0 shadow-none focus-visible:ring-0 px-0"
          />
        </div>

        {state?.title && <span className="browser-page-title">{state.title}</span>}
      </div>

      <div ref={placeholderRef} className="browser-viewport" />
    </div>
  );
}
