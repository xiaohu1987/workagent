import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

type RendererErrorBoundaryState = {
  error: Error | null;
};

class RendererErrorBoundary extends React.Component<React.PropsWithChildren, RendererErrorBoundaryState> {
  state: RendererErrorBoundaryState = { error: null };

  componentDidMount(): void {
    window.setTimeout(() => {
      try {
        window.sessionStorage.removeItem("codexh.renderer-recovery-attempt");
      } catch {
        // Storage can be unavailable in a restricted renderer; the fallback remains usable.
      }
    }, 2_000);
  }

  static getDerivedStateFromError(error: Error): RendererErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    window.codexh.reportRendererError({ message: error.message, stack: error.stack, componentStack: info.componentStack ?? undefined });
    try {
      const attempts = Number(window.sessionStorage.getItem("codexh.renderer-recovery-attempt") ?? "0");
      if (attempts < 1) {
        window.sessionStorage.setItem("codexh.renderer-recovery-attempt", String(attempts + 1));
        window.setTimeout(() => window.location.reload(), 250);
      }
    } catch {
      // Keep the diagnostic page visible when automatic recovery cannot be scheduled.
    }
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 32, color: "#f3f4f6", background: "#09090a", fontFamily: "Segoe UI, sans-serif" }}>
        <section style={{ width: "min(720px, 100%)", border: "1px solid #3f4248", borderRadius: 8, padding: 24, background: "#141518" }}>
          <h1 style={{ margin: "0 0 12px", fontSize: 18 }}>界面遇到异常</h1>
          <p style={{ margin: "0 0 16px", color: "#b7bdc8", lineHeight: 1.6 }}>后台任务仍在运行，重新加载界面不会清除任务记录。</p>
          <code style={{ display: "block", marginBottom: 18, color: "#ffb4a8", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{this.state.error.message}</code>
          <button type="button" onClick={() => window.location.reload()} style={{ border: 0, borderRadius: 6, padding: "8px 14px", color: "#101114", background: "#9bd0ff", cursor: "pointer" }}>重新加载界面</button>
        </section>
      </main>
    );
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root element is missing.");

window.addEventListener("error", (event) => {
  window.codexh.reportRendererError({ message: event.message, stack: event.error?.stack });
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
  window.codexh.reportRendererError({ message: reason.message, stack: reason.stack, unhandledRejection: true });
});

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <RendererErrorBoundary>
      <App />
    </RendererErrorBoundary>
  </React.StrictMode>
);
