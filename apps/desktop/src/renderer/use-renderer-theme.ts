import { useEffect, useState } from "react";

export type RendererTheme = "light" | "dark";

function readRendererTheme(): RendererTheme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function useRendererTheme(): RendererTheme {
  const [theme, setTheme] = useState<RendererTheme>(readRendererTheme);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(readRendererTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return theme;
}
