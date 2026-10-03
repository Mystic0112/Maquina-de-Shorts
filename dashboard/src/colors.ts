import { useCallback, useEffect, useState } from "react";
import type { CategoryInfo, StageName } from "../shared/api";
import { STAGE_NAMES } from "../shared/api";

/**
 * Fixed color assignments (never by rank, never cycled):
 * - topic categories take categorical slots 1..3 in config order (validated all-pairs);
 * - footage sources take slots 7, 5, 6, 4 (validated adjacent-pairs, light + dark);
 * - pipeline stages use the ordinal blue ramp (they are ordered steps 01..06).
 */
const CATEGORY_SLOTS = ["var(--cat-1)", "var(--cat-2)", "var(--cat-3)"];
const SOURCE_COLORS: Record<string, string> = {
  wikimedia: "var(--cat-7)",
  nasa: "var(--cat-5)",
  pexels: "var(--cat-6)",
  pixabay: "var(--cat-4)",
};
export const OTHER_COLOR = "var(--other)";

export function categoryColor(categoryId: string | null | undefined, categories: CategoryInfo[]): string {
  const index = categories.findIndex((c) => c.id === categoryId);
  return CATEGORY_SLOTS[index] ?? OTHER_COLOR; // a 4th+ category folds into "Outros" gray
}

export const sourceColor = (source: string): string => SOURCE_COLORS[source.toLowerCase()] ?? OTHER_COLOR;

export const stageColor = (stage: StageName): string => `var(--stage-${STAGE_NAMES.indexOf(stage) + 1})`;

/** Sequential blue (palette steps 100..700) for 0-10 relevance scores; returns fill + readable ink. */
const SEQ = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#104281"];
export function scoreColor(score: number): { bg: string; ink: string } {
  const i = Math.max(0, Math.min(10, Math.round(score)));
  return { bg: SEQ[i]!, ink: i >= 6 ? "#ffffff" : "#0b0b0b" };
}

type Theme = "dark" | "light";
const STORAGE_KEY = "painel-theme";

export function readStoredTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** Dark by default; the toggle is remembered per browser (a convenience only). */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // storage blocked: theme still works for this session
    }
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return [theme, toggle];
}
