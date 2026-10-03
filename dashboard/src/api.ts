import { useCallback, useEffect, useState } from "react";
import type { Overview, RefreshResponse, RunSummary, VideoRow } from "../shared/api";

export const POLL_MS = 60_000;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface DashboardData {
  overview: Overview;
  runs: RunSummary[];
  videos: VideoRow[];
}

/** Loads all local data and re-polls every 60 s (local files only; YouTube follows the server cadence). */
export function useDashboardData() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [overview, runs, videos] = await Promise.all([
        getJson<Overview>("/api/overview"),
        getJson<RunSummary[]>("/api/runs"),
        getJson<VideoRow[]>("/api/videos"),
      ]);
      setData({ overview, runs, videos });
      setError(null);
      setLoadedAt(new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  return { data, error, loadedAt, reload };
}

export async function requestYoutubeRefresh(): Promise<RefreshResponse> {
  const res = await fetch("/api/youtube/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return (await res.json()) as RefreshResponse;
}
