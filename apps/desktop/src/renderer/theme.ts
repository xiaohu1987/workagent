import type { AppConfig } from "@shared-types";

export type AppTheme = "light" | "dark";

export function resolveAppTheme(theme: AppConfig["desktop"]["theme"] | null | undefined): AppTheme {
  return theme === "light" ? "light" : "dark";
}

export function applyAppTheme(theme: AppConfig["desktop"]["theme"] | null | undefined): AppTheme {
  const resolvedTheme = resolveAppTheme(theme);
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.style.colorScheme = resolvedTheme;
  return resolvedTheme;
}
