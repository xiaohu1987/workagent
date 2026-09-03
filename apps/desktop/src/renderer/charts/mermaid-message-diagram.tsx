import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useRendererTheme, type RendererTheme } from "../use-renderer-theme";
import "./mermaid-message-diagram.css";

let mermaidSequence = 0;
let mermaidRenderQueue: Promise<void> = Promise.resolve();

type MermaidRenderState =
  | { status: "loading" }
  | { status: "ready"; svg: string }
  | { status: "error"; message: string };

function renderMermaid(source: string, theme: RendererTheme, id: string): Promise<string> {
  const task = mermaidRenderQueue.then(async () => {
    const module = await import("mermaid");
    const mermaid = module.default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
      fontFamily: "Segoe UI, Microsoft YaHei, sans-serif",
      themeVariables: theme === "light"
        ? {
            background: "#ffffff",
            primaryColor: "#eaf4ff",
            primaryTextColor: "#1f2937",
            primaryBorderColor: "#75b8f5",
            secondaryColor: "#f3e8ff",
            secondaryTextColor: "#1f2937",
            secondaryBorderColor: "#b79aef",
            tertiaryColor: "#ecfdf3",
            tertiaryTextColor: "#1f2937",
            tertiaryBorderColor: "#76c893",
            lineColor: "#6b7f92",
            textColor: "#1f2937",
            mainBkg: "#ffffff",
            nodeBorder: "#b8cad9",
            clusterBkg: "#f6f8fa",
            clusterBorder: "#d0d7de",
            edgeLabelBackground: "#ffffff",
            noteBkgColor: "#fff8dc",
            noteBorderColor: "#d6ad47",
            noteTextColor: "#4b3b12",
            actorBkg: "#ffffff",
            actorBorder: "#75b8f5",
            actorTextColor: "#1f2937",
            signalColor: "#52677a",
            signalTextColor: "#1f2937",
            labelBoxBkgColor: "#ffffff",
            labelBoxBorderColor: "#b8cad9",
            labelTextColor: "#1f2937"
          }
        : {
            background: "#101217",
            primaryColor: "#1d2938",
            primaryTextColor: "#eef2f8",
            primaryBorderColor: "#5e91c8",
            secondaryColor: "#29213a",
            secondaryTextColor: "#eef2f8",
            secondaryBorderColor: "#8b72b8",
            tertiaryColor: "#17332c",
            tertiaryTextColor: "#eef2f8",
            tertiaryBorderColor: "#4c8e78",
            lineColor: "#9ba9b8",
            textColor: "#eef2f8",
            mainBkg: "#171b22",
            nodeBorder: "#52677a",
            clusterBkg: "#141820",
            clusterBorder: "#3c4654",
            edgeLabelBackground: "#101217",
            noteBkgColor: "#332d1c",
            noteBorderColor: "#8f783f",
            noteTextColor: "#f1e6bd"
          },
      flowchart: { htmlLabels: false },
      sequence: { useMaxWidth: true }
    });
    const rendered = await mermaid.render(id, source);
    return rendered.svg;
  });
  mermaidRenderQueue = task.then(() => undefined, () => undefined);
  return task;
}

export function MermaidMessageDiagram({ source, copyControl }: { source: string; copyControl: ReactNode }) {
  const theme = useRendererTheme();
  const diagramId = useRef(`codexh-mermaid-${++mermaidSequence}`);
  const [state, setState] = useState<MermaidRenderState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    void renderMermaid(source, theme, `${diagramId.current}-${theme}`)
      .then((svg) => {
        if (active) setState({ status: "ready", svg });
      })
      .catch((error: unknown) => {
        if (active) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      active = false;
    };
  }, [source, theme]);

  return (
    <section className="markdown-mermaid" aria-label="Mermaid 图表">
      <header className="markdown-mermaid-head">
        <span>流程图</span>
        {copyControl}
      </header>
      {state.status === "ready" ? (
        <div className="markdown-mermaid-canvas" dangerouslySetInnerHTML={{ __html: state.svg }} />
      ) : state.status === "error" ? (
        <div className="markdown-mermaid-error" role="alert">
          <strong>图表渲染失败</strong>
          <span>{state.message}</span>
          <pre>{source}</pre>
        </div>
      ) : (
        <div className="markdown-mermaid-loading" aria-live="polite">正在渲染图表...</div>
      )}
    </section>
  );
}
