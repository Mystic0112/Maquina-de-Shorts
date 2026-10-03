import { defaultHttp, graphUrl, InstagramApiError, requestJson, type HttpFetch } from "./instagramApi.js";

/**
 * Per-Reel metrics for the dashboard (GET /<IG_MEDIA_ID>/insights, needs instagram_business_manage_insights).
 * Meta deprecated the `plays` metric in v22 (replaced by `views`, "times the media was played"), so
 * `plays` below is read from `views`. A metric Meta has no data for yet comes back missing -> null.
 * Data can lag up to 48 h.
 * https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights
 */

export const REEL_METRICS = ["views", "reach", "likes", "comments", "saved"] as const;

export interface ReelInsights {
  mediaId: string;
  plays: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  fetchedAt: string;
}

function metricValue(entry: Record<string, unknown>): number | null {
  const total = (entry.total_value as { value?: unknown } | undefined)?.value;
  const first = Array.isArray(entry.values) ? (entry.values[0] as { value?: unknown } | undefined)?.value : undefined;
  const value = typeof total === "number" ? total : first;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Pure: insights response -> named metrics. */
export function parseInsights(mediaId: string, body: Record<string, unknown>, now: Date = new Date()): ReelInsights {
  const byName = new Map<string, number | null>();
  for (const raw of Array.isArray(body.data) ? body.data : []) {
    const entry = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
    if (entry && typeof entry.name === "string") byName.set(entry.name, metricValue(entry));
  }
  const get = (name: string): number | null => byName.get(name) ?? null;
  return {
    mediaId,
    plays: get("views"),
    reach: get("reach"),
    likes: get("likes"),
    comments: get("comments"),
    saves: get("saved"),
    fetchedAt: now.toISOString(),
  };
}

export interface InsightsDeps {
  accessToken: string;
  http?: HttpFetch;
  now?: () => Date;
}

export async function fetchReelInsights(mediaId: string, deps: InsightsDeps): Promise<ReelInsights> {
  if (!/^\d{1,40}$/.test(mediaId)) throw new InstagramApiError(`Invalid Instagram media id "${mediaId.slice(0, 40)}"`);
  const url = graphUrl(`${mediaId}/insights`, { metric: REEL_METRICS.join(","), access_token: deps.accessToken });
  const body = await requestJson(deps.http ?? defaultHttp, url, { method: "GET" });
  return parseInsights(mediaId, body, (deps.now ?? (() => new Date()))());
}

/** Several Reels; one failing media never hides the others (its error is returned instead). */
export async function fetchManyReelInsights(mediaIds: readonly string[], deps: InsightsDeps): Promise<Array<ReelInsights | { mediaId: string; error: string }>> {
  const results: Array<ReelInsights | { mediaId: string; error: string }> = [];
  for (const mediaId of mediaIds) {
    try {
      results.push(await fetchReelInsights(mediaId, deps));
    } catch (error) {
      results.push({ mediaId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
