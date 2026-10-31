import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  /** Rendered instead of the full-screen panel — for overlays, which must not
   *  replace the page they sit on when they fail. */
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render/lifecycle errors anywhere in the tree so a component crash
 * shows a recoverable error panel instead of a silent black window.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Renderer crash caught by ErrorBoundary:", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-4 p-8 text-center">
          <AlertTriangle className="h-10 w-10 text-destructive" />
          <div>
            <h2 className="text-lg font-semibold">Something broke in the UI</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              The app state is safe — this is a display error only. Details below have been logged to the console.
            </p>
          </div>
          <pre className="max-h-40 max-w-xl overflow-auto rounded-md border bg-card p-3 text-left text-xs text-destructive">
            {this.state.error.message}
            {"\n"}
            {this.state.error.stack?.split("\n").slice(1, 6).join("\n")}
          </pre>
          <Button onClick={() => this.setState({ error: null })}>Reload UI</Button>
        </div>
      );
    }
    return this.props.children;
  }
}
