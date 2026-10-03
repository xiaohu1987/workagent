/** Writes compact, content-free tool timeline diagnostics to the app runtime log. */
export function reportToolTimelineDiagnostic(payload: Record<string, unknown>): void {
  try {
    console.info("[tool-timeline-diag]", JSON.stringify(payload));
    window.codexh.reportToolTimelineDiagnostic(payload);
  } catch {
    // Diagnostics must never interfere with transcript rendering.
  }
}
